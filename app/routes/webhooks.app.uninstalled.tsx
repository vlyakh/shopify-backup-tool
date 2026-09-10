import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { planTransition } from "../services/plan.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const triggeredAtHeader = request.headers.get("X-Shopify-Triggered-At");
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopify delivers webhooks at-least-once and retries failed deliveries for
  // hours (e.g. the single instance is down during a deploy), so this can land
  // AFTER the merchant has already reinstalled. If the store completed OAuth
  // after this event fired, it's a stale delivery for a live install —
  // deleting the fresh session/schedule, disabling tracking, and stamping a
  // post-reinstall uninstalledAt would silently kill the install (the next
  // afterAuth would wipe the post-reinstall ledger, and purgeUninstalledStores
  // would erase everything after 30 days). Drop it instead.
  const triggeredAtMs = triggeredAtHeader
    ? Date.parse(triggeredAtHeader)
    : NaN;
  // Missing/unparseable header: treat the event as "now" so a genuine
  // uninstall still processes below.
  const triggeredAt = Number.isNaN(triggeredAtMs)
    ? new Date()
    : new Date(triggeredAtMs);
  const store = await db.store.findUnique({
    where: { id: shop },
    select: { lastAuthAt: true, plan: true, retentionDays: true },
  });
  if (store?.lastAuthAt && store.lastAuthAt > triggeredAt) {
    console.log(
      `Ignoring stale ${topic} for ${shop}: store re-authenticated at ` +
        `${store.lastAuthAt.toISOString()}, after the event fired at ` +
        `${triggeredAt.toISOString()}`,
    );
    return new Response();
  }

  // Stop the scheduler from selecting this store every tick — with the offline
  // session gone each run would just throw SessionNotFoundError forever — and
  // stop the webhook processor from recording changes. autoBackupEnabled must
  // go false too, or ensureSchedulesExist recreates the deleted schedule on
  // the next app restart. uninstalledAt marks the store so afterAuth
  // re-baselines (fresh backup, pre-uninstall ledger dropped) on reinstall.
  //
  // The lastAuthAt condition re-checks the guard above ATOMICALLY: a
  // reinstall's afterAuth can commit a new lastAuthAt between that read and
  // this write, and stamping a post-reinstall uninstalledAt here would arm
  // the ledger wipe/30-day purge on a live install. The destructive deletes
  // below only run once this stamp lands, so a racing reinstall also keeps
  // its fresh session and schedule.
  //
  // The plan drops to FREE here because Shopify cancels every app subscription
  // on uninstall — the shop is provably not paying for anything the moment
  // this event is genuine. Leaving the cached plan on its old paid value is
  // what failed App Store review 1.2.2: a reinstalled shop came back showing
  // Premium as its current plan, which also left the Premium card drawn as a
  // disabled "Current Plan" with no way to request approval for the charge
  // again. Routed through planTransition so the retention shrink is staged
  // behind the grace period rather than arming the sweep to delete the
  // merchant's history within the hour — they may well reinstall.
  const stamped = await db.store.updateMany({
    where: {
      id: shop,
      OR: [{ lastAuthAt: null }, { lastAuthAt: { lte: triggeredAt } }],
    },
    data: {
      ...planTransition(store, "FREE"),
      webhooksEnabled: false,
      autoBackupEnabled: false,
      uninstalledAt: new Date(),
    },
  });
  if (store && stamped.count === 0) {
    console.log(
      `Ignoring stale ${topic} for ${shop}: store re-authenticated while this delivery was being processed`,
    );
    return new Response();
  }

  await db.backupSchedule.deleteMany({ where: { storeId: shop } });

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};

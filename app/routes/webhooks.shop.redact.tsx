import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const triggeredAtHeader = request.headers.get("X-Shopify-Triggered-At");
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Shopify schedules shop/redact ~48h after an uninstall and delivers it on
  // its own timer, whether or not the merchant reinstalled in the meantime —
  // and a reinstall reuses the same Store row (id is the shop domain), so a
  // late delivery would land on a LIVE install and erase a paying merchant's
  // backups, their whole change ledger and their current session token.
  // Accidental-uninstall-then-reinstall inside that window is an ordinary
  // flow. Same at-least-once race the app/uninstalled handler guards, same
  // guard here: if the store completed OAuth after this event fired, it is a
  // stale request for an install that is no longer erased — drop it.
  //
  // This does not weaken the compliance guarantee: a merchant who is really
  // gone never re-authenticates, so lastAuthAt stays behind triggeredAt and
  // the erasure below runs. Shopify also re-sends the request if the shop is
  // uninstalled again.
  const triggeredAtMs = triggeredAtHeader ? Date.parse(triggeredAtHeader) : NaN;
  // Missing/unparseable header: treat the event as "now" so a genuine erasure
  // request still processes below.
  const triggeredAt = Number.isNaN(triggeredAtMs)
    ? new Date()
    : new Date(triggeredAtMs);
  const store = await prisma.store.findUnique({
    where: { id: shop },
    select: { lastAuthAt: true },
  });
  if (store?.lastAuthAt && store.lastAuthAt > triggeredAt) {
    console.log(
      `Ignoring stale ${topic} for ${shop}: store re-authenticated at ` +
        `${store.lastAuthAt.toISOString()}, after the event fired at ` +
        `${triggeredAt.toISOString()}`,
    );
    return new Response(null, { status: 200 });
  }

  // Shop data erasure request - delete ALL data for this shop.
  // Every blob lives under `${shop}/` (backups, changes/, state/), so one
  // prefix delete erases the lot.
  await storage.deletePrefix(`${shop}/`);

  // Delete all database records
  await prisma.feedback.deleteMany({ where: { storeId: shop } });
  await prisma.changeLog.deleteMany({ where: { storeId: shop } });
  await prisma.webhookEvent.deleteMany({ where: { storeId: shop } });
  await prisma.revertSuppression.deleteMany({ where: { storeId: shop } });
  await prisma.backupItem.deleteMany({
    where: { backup: { storeId: shop } },
  });
  await prisma.backup.deleteMany({ where: { storeId: shop } });
  await prisma.backupSchedule.deleteMany({ where: { storeId: shop } });
  await prisma.store.deleteMany({ where: { id: shop } });
  // Sessions hold access tokens and staff PII (email, first/last name); this
  // is the mandated final erasure signal, so remove them even if the
  // app/uninstalled delivery that normally does it was missed.
  await prisma.session.deleteMany({ where: { shop } });

  return new Response(null, { status: 200 });
};

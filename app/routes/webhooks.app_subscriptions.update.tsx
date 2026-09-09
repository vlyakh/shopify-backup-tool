import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, tierForPlanName } from "../shopify.server";
import prisma from "../db.server";
import { planTransition, resolveActivePlan } from "../services/plan.server";
import type { PlanId } from "../billing";

/**
 * Keeps the cached store.plan in step with Shopify's billing state.
 *
 * Without this, the ONLY place that reconciled the plan was the settings
 * loader — so a subscription Shopify cancelled on its own (a
 * declined card, or the merchant cancelling from Shopify's billing UI rather
 * than our settings page) left store.plan on its old paid value indefinitely.
 * Everything else — the dashboard, the scheduler that fires paid-only
 * automatic backups, the change-tracking entitlement — reads that cached
 * value, so a merchant who had stopped paying kept every paid entitlement
 * until they happened to reopen a page they had no reason to visit.
 *
 * Downgrades route through planTransition, so a cancellation stages the
 * retention shrink behind the grace period instead of arming the retention
 * sweep to delete the merchant's history within the hour.
 *
 * The event says only that SOME subscription changed state — never that the
 * shop's entitlement changed. Replacing a plan cancels the old subscription
 * and activates the new one, which fires two of these, and Shopify does not
 * guarantee the order they arrive in. Trusting the event's own status meant
 * that whenever the CANCELLED delivery landed after the ACTIVE one, the shop
 * was dropped to Free while its new Premium subscription was live. The App
 * Store reviewer hit that on 2026-09-07 (13:57:57.4 ACTIVE, 13:57:57.6
 * CANCELLED, store left on Free).
 *
 * So the event is only a trigger: the plan itself is re-read from Shopify, and
 * the answer is the same whichever order the two deliveries arrive in.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const subscription = (payload as { app_subscription?: Record<string, unknown> })
    ?.app_subscription;
  const status = String(subscription?.status ?? "").toUpperCase();
  const name = String(subscription?.name ?? "");

  console.log(`[Webhook] ${topic} for ${shop}: ${name} -> ${status}`);

  const isTerminal =
    status === "CANCELLED" ||
    status === "EXPIRED" ||
    status === "DECLINED" ||
    // FROZEN included: the shop is suspended for non-payment, so it is not
    // paying us either.
    status === "FROZEN";
  if (status !== "ACTIVE" && !isTerminal) {
    // PENDING / ACCEPTED and anything unrecognised: the merchant has not been
    // charged yet and their existing subscription (if any) is untouched.
    // Acting here could revoke a plan they are still paying for.
    return new Response(null, { status: 200 });
  }

  const store = await prisma.store.findUnique({ where: { id: shop } });
  if (!store) return new Response(null, { status: 200 });

  let plan: PlanId;
  if (admin) {
    try {
      plan = (await resolveActivePlan(admin)).plan;
    } catch (error) {
      console.warn(
        `[Webhook] Could not read active subscriptions for ${shop}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // An ACTIVE event is safe to act on unverified — it can only grant. A
      // cancellation is not: this delivery may be the tail of a plan
      // replacement, and downgrading on a guess is what broke review. Leave
      // the plan as it is; the settings loader reconciles on the next visit.
      if (isTerminal) return new Response(null, { status: 200 });
      plan = tierForPlanName(name);
    }
  } else {
    // No session for this shop (uninstalled, mid-reinstall): nothing to query
    // with. Same asymmetry as above.
    if (isTerminal) return new Response(null, { status: 200 });
    plan = tierForPlanName(name);
  }

  // A shop that has held a paid subscription has used its trial — record it
  // here too, not just in the settings loader, so a merchant who never
  // reopens Settings still can't collect a second trial.
  if (plan !== "FREE" && !store.trialUsedAt) {
    await prisma.store.update({
      where: { id: shop },
      data: { trialUsedAt: new Date() },
    });
  }

  if (store.plan === plan) return new Response(null, { status: 200 });

  await prisma.store.update({
    where: { id: shop },
    data: planTransition(store, plan),
  });
  console.log(`[Webhook] ${shop}: plan ${store.plan} -> ${plan}`);

  return new Response(null, { status: 200 });
};

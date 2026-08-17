import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, tierForPlanName } from "../shopify.server";
import prisma from "../db.server";
import { planTransition } from "../services/plan.server";
import type { PlanId } from "../billing";

/**
 * Keeps the cached store.plan in step with Shopify's billing state.
 *
 * Without this, the ONLY place that reconciled the plan was the settings
 * loader's billing.check — so a subscription Shopify cancelled on its own (a
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
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const subscription = (payload as { app_subscription?: Record<string, unknown> })
    ?.app_subscription;
  const status = String(subscription?.status ?? "").toUpperCase();
  const name = String(subscription?.name ?? "");

  console.log(`[Webhook] ${topic} for ${shop}: ${name} -> ${status}`);

  let plan: PlanId;
  if (status === "ACTIVE") {
    plan = tierForPlanName(name);
  } else if (
    status === "CANCELLED" ||
    status === "EXPIRED" ||
    status === "DECLINED" ||
    status === "FROZEN"
  ) {
    // Entitlement is gone. FROZEN included: the shop is suspended for
    // non-payment, so it is not paying us either.
    plan = "FREE";
  } else {
    // PENDING / ACCEPTED and anything unrecognised: the merchant has not been
    // charged yet and their existing subscription (if any) is untouched.
    // Acting here could revoke a plan they are still paying for.
    return new Response(null, { status: 200 });
  }

  const store = await prisma.store.findUnique({ where: { id: shop } });
  if (!store) return new Response(null, { status: 200 });

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

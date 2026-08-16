// Billing constants shared by server and client code.
//
// Deliberately NOT in shopify.server.ts: the settings route renders plan copy
// (the PLANS array) at module scope, so anything it reads must be safe to pull
// into the client bundle. Importing this from shopify.server.ts would make
// Remix refuse the build ("Server-only module referenced by client").

// Free trial length on both paid plans. Must match the trial advertised on the
// App Store listing — review checks that the listing and what the app actually
// charges agree.
export const TRIAL_DAYS = 14;

export type PlanId = "FREE" | "STANDARD" | "PREMIUM";

/**
 * How long a backup is kept, per plan. This is the ONLY place these numbers
 * live — the settings plan cards, the plan-transition logic and the retention
 * sweep all read them from here, so a pricing change can't leave the UI
 * advertising one window while the scheduler enforces another.
 */
export function planRetentionDays(plan: PlanId): number {
  switch (plan) {
    case "PREMIUM":
      return 90;
    case "STANDARD":
      return 30;
    default:
      return 7;
  }
}

/**
 * Grace period before a *shrinking* retention window takes effect.
 *
 * Dropping from Premium (90d) to Free (7d) makes every backup older than a
 * week eligible for permanent deletion by the retention sweep, which runs
 * within the hour. That is unrecoverable — there is no soft delete — and it
 * fires on paths the merchant never explicitly confirmed: a lapsed trial, a
 * declined card, or a subscription cancelled from Shopify's own billing UI.
 * The 14-day trial routes far more merchants through exactly that path.
 *
 * So a shrink is staged rather than applied: the old, larger window stays in
 * force until this many days have passed, giving the merchant time to notice
 * and resubscribe with their history intact. Re-subscribing clears the staged
 * shrink outright. Growing the window (an upgrade) still applies immediately —
 * there is nothing to protect against.
 */
export const RETENTION_GRACE_DAYS = 30;

import {
  RETENTION_GRACE_DAYS,
  planRetentionDays,
  type PlanId,
} from "../billing";

/**
 * Whether to create TEST charges (Shopify records the subscription but no
 * money moves) instead of real ones.
 *
 * Defaults to NODE_ENV, but is overridable, because the two are not the same
 * question. Both deployments run NODE_ENV=production — dev included, since its
 * bundle is built as production and its devDependencies are pruned — so
 * NODE_ENV alone can never say "this is a throwaway test charge". And the
 * Billing API is unavailable to non-public apps, so billing can only ever be
 * exercised against a public app, which is the production one.
 *
 * Set SHOPIFY_BILLING_TEST=true to force test charges while verifying the
 * billing flow, then REMOVE IT. Leaving it on means every merchant subscribes
 * for free — hence the startup warning below, which is deliberately loud.
 */
export function isTestBilling(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV !== "production";
}

if (
  process.env.SHOPIFY_BILLING_TEST === "true" &&
  process.env.NODE_ENV === "production"
) {
  console.warn(
    "[Billing] *** TEST BILLING IS ON IN A PRODUCTION BUILD *** " +
      "Every subscription is a test charge and NO MONEY WILL BE COLLECTED. " +
      "Remove the SHOPIFY_BILLING_TEST app setting once testing is done.",
  );
}

/**
 * The stored settings for a plan transition.
 *
 * Deliberately does NOT touch webhooksEnabled: afterAuth turns it on for every
 * install and it is the lifecycle switch for the change ledger (uninstall
 * turns it off). Plan entitlement is checked separately — see
 * isChangeTrackingEntitled in changelog.server.ts.
 *
 * A retention *shrink* is staged rather than applied. Dropping Premium's 90
 * days to Free's 7 makes almost every backup immediately eligible for
 * permanent deletion by the hourly retention sweep, and that happens on paths
 * the merchant never confirmed: a lapsed trial, a declined card, or a
 * cancellation made from Shopify's own billing UI. The larger window stays in
 * force for RETENTION_GRACE_DAYS so they have time to notice and resubscribe.
 * Growing the window applies at once and clears any staged shrink — there is
 * nothing to protect against when the merchant gains retention.
 */
export function planTransition(
  current: { retentionDays: number } | null,
  plan: PlanId,
) {
  const target = planRetentionDays(plan);
  // Automatic backups are a paid entitlement; drop them on downgrade.
  const base = plan === "FREE" ? { plan, autoBackupEnabled: false } : { plan };

  if (!current || target >= current.retentionDays) {
    return {
      ...base,
      retentionDays: target,
      pendingRetentionDays: null,
      pendingRetentionAt: null,
    };
  }

  return {
    ...base,
    // retentionDays deliberately untouched — the old, larger window stays in
    // force until the grace period elapses.
    pendingRetentionDays: target,
    pendingRetentionAt: new Date(
      Date.now() + RETENTION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
}

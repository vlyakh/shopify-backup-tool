import {
  RETENTION_GRACE_DAYS,
  planRetentionDays,
  type PlanId,
} from "../billing";

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

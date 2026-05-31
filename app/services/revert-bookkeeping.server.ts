/**
 * In-memory bookkeeping for the per-edit Undo so the change history "clears" as
 * the merchant undoes edits.
 *
 * Two problems this solves:
 *  1. Undoing an edit is itself a product write → Shopify re-fires products/update
 *     → it would be recorded as a NEW change row. We SUPPRESS the next webhook for
 *     that product so the undo doesn't pile onto the list.
 *  2. The original edit's row must disappear once undone. We mark (changeId, field)
 *     UNDONE and the history endpoint filters those rows out.
 *
 * State is process-local (single-instance app) and resets on redeploy — acceptable
 * for this UX; a DB-backed version can replace it later without changing callers.
 */

const SUPPRESS_MS = 90_000;

// resourceId (product GID) → { remaining suppressions, expiry }
const suppress = new Map<string, { count: number; expiry: number }>();
// resourceId → timestamp until which ALL product webhooks are skipped (revert-all)
const suppressWindow = new Map<string, number>();
// `${changeId}::${field}` of edits the merchant has undone
const undone = new Set<string>();

/** Mark that the NEXT products/update webhook for this product is our own revert. */
export function suppressNextWebhook(resourceId: string): void {
  const now = Date.now();
  const existing = suppress.get(resourceId);
  const expiry = now + SUPPRESS_MS;
  if (existing && existing.expiry > now) {
    suppress.set(resourceId, { count: existing.count + 1, expiry });
  } else {
    suppress.set(resourceId, { count: 1, expiry });
  }
}

/**
 * Skip ALL products/update webhooks for this product for a short burst window —
 * for "Revert all to backup", which fires several writes (product + variants +
 * media) and so several webhooks. Short (10s) so it can't swallow a later edit.
 */
export function suppressWebhooksFor(resourceId: string, ms = 10_000): void {
  suppressWindow.set(resourceId, Date.now() + ms);
}

/** Consume one suppression for this product; true if its webhook should be skipped. */
export function consumeSuppression(resourceId: string): boolean {
  const windowUntil = suppressWindow.get(resourceId);
  if (windowUntil && windowUntil > Date.now()) return true; // burst window: skip all
  if (windowUntil) suppressWindow.delete(resourceId);

  const entry = suppress.get(resourceId);
  if (entry && entry.expiry > Date.now() && entry.count > 0) {
    if (entry.count <= 1) suppress.delete(resourceId);
    else suppress.set(resourceId, { count: entry.count - 1, expiry: entry.expiry });
    return true;
  }
  if (entry) suppress.delete(resourceId); // expired cleanup
  return false;
}

export function markUndone(changeId: string, field: string): void {
  undone.add(`${changeId}::${field}`);
}

export function isUndone(changeId: string, field: string): boolean {
  return undone.has(`${changeId}::${field}`);
}

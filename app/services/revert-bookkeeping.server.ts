/**
 * In-memory bookkeeping so the change history "clears" as the merchant undoes
 * edits, WITHOUT breaking the change-tracking chain.
 *
 * Key lesson: a revert/undo is itself a product write that re-fires
 * products/update. We must still RECORD that webhook (so the ChangeLog baseline
 * advances — otherwise the next real edit diffs against a stale state and every
 * reverted field resurfaces), but MARK the recorded event HIDDEN so it doesn't
 * show. We also hide:
 *  - per-edit Undo: the original (changeId, field) — the row the merchant undid;
 *  - Revert-all: every event since the backup (all of it was undone).
 *
 * State is process-local (single-instance app) and resets on redeploy.
 */

const SUPPRESS_MS = 90_000;

// resourceId (product GID) → { remaining hide-marks, expiry } for the next webhooks
const suppress = new Map<string, { count: number; expiry: number }>();
// resourceId → timestamp until which ALL product webhooks are hidden (revert-all)
const suppressWindow = new Map<string, number>();
// `${changeId}::${field}` of edits the merchant has undone
const undone = new Set<string>();
// ChangeLog event ids that are revert-generated and must not show in history
const hiddenEvents = new Set<string>();

/** Mark a recorded ChangeLog event as revert-generated (hidden from history). */
export function markHidden(eventId: string): void {
  hiddenEvents.add(eventId);
}

export function isHidden(eventId: string): boolean {
  return hiddenEvents.has(eventId);
}

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

/** Consume one mark for this product; true if its just-recorded event should be HIDDEN. */
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

/**
 * DB-backed bookkeeping so the change history "clears" as the merchant undoes
 * edits, WITHOUT breaking the change-tracking chain.
 *
 * Key lesson: a revert/undo is itself a product write that re-fires
 * products/update. We must still RECORD that webhook (so the ChangeLog baseline
 * advances — otherwise the next real edit diffs against a stale state and every
 * reverted field resurfaces), but record it with `hidden: true` so it doesn't
 * show. We also hide:
 *  - per-edit Undo: the original (changeId, field) — stored in
 *    ChangeLog.undoneFields on the row the merchant undid;
 *  - Revert-all: every event since the backup (ChangeLog.hidden = true).
 *
 * Suppression marks ("the next webhook for this product is our own revert")
 * live in the RevertSuppression table, so they survive restarts/redeploys and
 * work when the webhook is processed by a different instance than the one that
 * handled the revert.
 */

import prisma from "../db.server";

const SUPPRESS_MS = 90_000;

/** Mark that the NEXT products/update webhook for this product is our own revert. */
export async function suppressNextWebhook(
  storeId: string,
  resourceId: string,
): Promise<void> {
  const expiry = new Date(Date.now() + SUPPRESS_MS);
  // One atomic statement: bump a still-valid mark, or start fresh at 1 (an
  // expired leftover count must not carry over — it could swallow a real
  // merchant edit). A read-then-write here would let two concurrent undos
  // collapse into one mark. Raw SQL must set updatedAt itself (@updatedAt is
  // client-side only).
  await prisma.$executeRaw`
    INSERT INTO "RevertSuppression" ("storeId", "resourceId", "count", "countExpiresAt", "updatedAt")
    VALUES (${storeId}, ${resourceId}, 1, ${expiry}, now())
    ON CONFLICT ("storeId", "resourceId") DO UPDATE
    SET "count" = CASE
          WHEN "RevertSuppression"."countExpiresAt" > now() THEN "RevertSuppression"."count" + 1
          ELSE 1
        END,
        "countExpiresAt" = EXCLUDED."countExpiresAt",
        "updatedAt" = now()`;
}

/**
 * Skip ALL products/update webhooks for this product for a short burst window —
 * for "Revert all to backup", which fires several writes (product + variants +
 * media) and so several webhooks. Short (10s) so it can't swallow a later edit.
 */
export async function suppressWebhooksFor(
  storeId: string,
  resourceId: string,
  ms = 10_000,
): Promise<void> {
  const windowUntil = new Date(Date.now() + ms);
  await prisma.revertSuppression.upsert({
    where: { storeId_resourceId: { storeId, resourceId } },
    create: { storeId, resourceId, windowUntil },
    update: { windowUntil },
  });
}

/**
 * Consume one mark for this product; true if its just-recorded event should be
 * HIDDEN. `deliveredAt` is when Shopify delivered the webhook (the queue
 * processes up to ~10s later, plus retries) — validity is judged against the
 * delivery time so an echo doesn't outlive its window in the queue.
 */
export async function consumeSuppression(
  storeId: string,
  resourceId: string,
  deliveredAt: Date = new Date(),
): Promise<boolean> {
  const now = new Date();
  const entry = await prisma.revertSuppression.findUnique({
    where: { storeId_resourceId: { storeId, resourceId } },
  });
  if (!entry) return false;

  // Burst window: hide everything delivered inside it, without consuming counts.
  if (entry.windowUntil && entry.windowUntil > deliveredAt) return true;

  // Atomically consume one count-mark if still valid (guards against two
  // webhooks for the same product racing in concurrent processor ticks).
  const consumed = await prisma.revertSuppression.updateMany({
    where: {
      storeId,
      resourceId,
      count: { gt: 0 },
      countExpiresAt: { gt: deliveredAt },
    },
    data: { count: { decrement: 1 } },
  });
  if (consumed.count > 0) return true;

  // Nothing valid left — clean up the stale row (ignore a concurrent delete).
  await prisma.revertSuppression.deleteMany({
    where: {
      storeId,
      resourceId,
      AND: [
        { OR: [{ windowUntil: null }, { windowUntil: { lte: now } }] },
        {
          OR: [
            { count: { lte: 0 } },
            { countExpiresAt: null },
            { countExpiresAt: { lte: now } },
          ],
        },
      ],
    },
  });
  return false;
}

/** Delete suppression rows that can no longer match anything (daily janitor). */
export async function cleanupExpiredSuppressions(): Promise<number> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Windows last 10s and count-marks 90s, so anything untouched for a day is dead.
  const { count } = await prisma.revertSuppression.deleteMany({
    where: { updatedAt: { lt: dayAgo } },
  });
  return count;
}

/** Record that the merchant undid (changeId, field) so the history hides that row. */
export async function markUndone(
  changeId: string,
  field: string,
): Promise<void> {
  // updateMany, not update: the row may have been deleted meanwhile (Reset
  // data / shop redact), and the Shopify write already succeeded — failing the
  // whole request over a missing bookkeeping row would report a false error.
  await prisma.changeLog.updateMany({
    where: { id: changeId },
    data: { undoneFields: { push: field } },
  });
}

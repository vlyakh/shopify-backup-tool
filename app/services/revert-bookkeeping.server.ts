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
  // armedAt is the match LOWER bound: a webhook delivered BEFORE the mark was
  // armed is a real merchant edit, not our echo. Reset it only when starting a
  // fresh logical mark (no still-valid mark of either kind) — bumping a live
  // mark keeps its original arm time.
  await prisma.$executeRaw`
    INSERT INTO "RevertSuppression" ("storeId", "resourceId", "count", "countExpiresAt", "armedAt", "updatedAt")
    VALUES (${storeId}, ${resourceId}, 1, ${expiry}, now(), now())
    ON CONFLICT ("storeId", "resourceId") DO UPDATE
    SET "count" = CASE
          WHEN "RevertSuppression"."countExpiresAt" > now() THEN "RevertSuppression"."count" + 1
          ELSE 1
        END,
        "countExpiresAt" = EXCLUDED."countExpiresAt",
        "armedAt" = CASE
          WHEN ("RevertSuppression"."count" > 0 AND "RevertSuppression"."countExpiresAt" > now())
            OR "RevertSuppression"."windowUntil" > now()
          THEN "RevertSuppression"."armedAt"
          ELSE now()
        END,
        "updatedAt" = now()`;
}

/**
 * Skip ALL products/update webhooks for this product for a short burst window —
 * for "Revert all to backup", which fires several writes (product + variants +
 * media) and so several webhooks. Short (10s) so it can't swallow a later edit.
 *
 * `anchorArmedAt`: for a REFRESH mid-run, pass the time the run FIRST armed the
 * window. If the previous window segment lapsed before the refresh (a throttled
 * write can outlast 10s), the upsert would otherwise reset armedAt to now() —
 * and echoes DELIVERED during the lapsed segment (but processed later; the
 * queue ticks every ~10s) would fail the armedAt lower bound and record as
 * visible phantom rows. The anchor restores the run's original lower bound, so
 * a refresh only ever EXTENDS coverage. Safe: everything since the anchor is
 * this run's own writes' echoes (a real edit in that span is overwritten by the
 * revert anyway).
 */
export async function suppressWebhooksFor(
  storeId: string,
  resourceId: string,
  ms = 10_000,
  anchorArmedAt?: Date,
): Promise<void> {
  const windowUntil = new Date(Date.now() + ms);
  const armIfFresh = anchorArmedAt ?? new Date();
  // Raw upsert for the same reason as suppressNextWebhook: armedAt (the match
  // lower bound) must only reset when no still-valid mark exists, atomically.
  await prisma.$executeRaw`
    INSERT INTO "RevertSuppression" ("storeId", "resourceId", "windowUntil", "armedAt", "updatedAt")
    VALUES (${storeId}, ${resourceId}, ${windowUntil}, ${armIfFresh}, now())
    ON CONFLICT ("storeId", "resourceId") DO UPDATE
    SET "windowUntil" = EXCLUDED."windowUntil",
        "armedAt" = CASE
          WHEN ("RevertSuppression"."count" > 0 AND "RevertSuppression"."countExpiresAt" > now())
            OR "RevertSuppression"."windowUntil" > now()
          THEN "RevertSuppression"."armedAt"
          ELSE EXCLUDED."armedAt"
        END,
        "updatedAt" = now()`;
}

/**
 * Disarm a burst window that was armed AHEAD of a revert whose write then
 * FAILED — no echo is coming, and leaving the window live would hide (record
 * hidden=true) real merchant edits made in its remaining ~10s. Clears ONLY the
 * window: a still-valid count-mark belongs to some other undo whose echo may
 * still be in flight. Erring toward clearing is the safe direction — worst
 * case a concurrent revert's echo records visibly; the reverse (hiding a real
 * edit) silently drops it from the ledger.
 */
export async function clearSuppressionWindow(
  storeId: string,
  resourceId: string,
): Promise<void> {
  await prisma.revertSuppression.updateMany({
    where: { storeId, resourceId },
    data: { windowUntil: null },
  });
}

/**
 * What consumeSuppression matched, so a caller whose record failed can re-arm
 * the EXACT same mark (shape + original expiry) for the retry — re-arming a
 * window as a fresh 90s count-mark could later swallow a real edit.
 */
export type ConsumedMark =
  | { kind: "window"; until: Date; armedAt: Date | null }
  | { kind: "count"; expiresAt: Date; armedAt: Date | null };

/**
 * Consume one mark for this product; non-null if its just-recorded event should
 * be HIDDEN. `deliveredAt` is when Shopify delivered the webhook (the queue
 * processes up to ~10s later, plus retries) — validity is judged against the
 * delivery time so an echo doesn't outlive its window in the queue. Marks only
 * match webhooks delivered AT OR AFTER armedAt — a real edit delivered before
 * the Undo click must not be consumed as our echo (NULL armedAt = no lower
 * bound, for rows armed before the column existed). When a count-mark and a
 * burst window are both live, the COUNT is consumed first (see below).
 */
export async function consumeSuppression(
  storeId: string,
  resourceId: string,
  deliveredAt: Date = new Date(),
): Promise<ConsumedMark | null> {
  const entry = await prisma.revertSuppression.findUnique({
    where: { storeId_resourceId: { storeId, resourceId } },
  });
  if (!entry) return null;

  // Count-marks are consumed BEFORE the burst window is looked at. Both mark
  // kinds share the single armedAt lower bound, and arming a window while a
  // count-mark is still valid keeps the count's earlier armedAt — so the
  // window retroactively covers deliveries from before it was armed, including
  // the count-mark's own echo (revert-all and the doubleEcho per-field undos
  // arm their window AHEAD of the writes, routinely overlapping a live count
  // on the same product). Checked window-first, that echo would be hidden
  // WITHOUT decrementing, leaking a live count (90s TTL) that then swallows
  // the NEXT real merchant edit as hidden — silently dropping it from the
  // ledger. Count-first keeps the accounting exact: echoes in the overlap
  // drain the counts, the window hides the rest, and nothing outlives the
  // window. Worst case a burst echo drains a count whose own echo only lands
  // after the window closed — that echo records visibly, the safe direction
  // (see clearSuppressionWindow).
  //
  // Atomically consume one count-mark if still valid (guards against two
  // webhooks for the same product racing in concurrent processor ticks).
  const consumed = await prisma.revertSuppression.updateMany({
    where: {
      storeId,
      resourceId,
      count: { gt: 0 },
      countExpiresAt: { gt: deliveredAt },
      OR: [{ armedAt: null }, { armedAt: { lte: deliveredAt } }],
    },
    data: { count: { decrement: 1 } },
  });
  if (consumed.count > 0) {
    return {
      kind: "count",
      // countExpiresAt from our read can only be stale-null if a concurrent arm
      // raced it; approximate with the standard mark length in that case.
      expiresAt:
        entry.countExpiresAt ?? new Date(deliveredAt.getTime() + SUPPRESS_MS),
      armedAt: entry.armedAt,
    };
  }

  // Burst window: hide everything else delivered inside it — the echoes beyond
  // the count balance (a revert-all / media reconcile fires several webhooks).
  if (
    entry.windowUntil &&
    entry.windowUntil > deliveredAt &&
    (entry.armedAt == null || entry.armedAt <= deliveredAt)
  ) {
    return { kind: "window", until: entry.windowUntil, armedAt: entry.armedAt };
  }

  // Nothing valid left — clean up the stale row (ignore a concurrent delete).
  // Staleness is judged against deliveredAt, the same clock the matching above
  // uses — NOT wall-clock now. A real edit delivered just BEFORE the mark was
  // armed lands here via the armedAt rejection while the mark is still live
  // for the LATER-delivered echoes queued behind it; a now-based check would
  // see the 10s window as wall-clock-expired by the time the tick runs and
  // delete it, resurfacing the whole burst. Anything that expired before this
  // delivery is expired for every event processed in delivery order. Caveat:
  // the retry path can reorder — a failed event goes back to PENDING while
  // later deliveries in the batch proceed, so a later event can delete a
  // rearmed mark an earlier echo's retry still needs (that retry then records
  // visibly; needs a transient record failure plus backlog, so rare and no
  // worse than losing the rearm entirely). Rows that never see another event
  // are reaped by the daily janitor below.
  await prisma.revertSuppression.deleteMany({
    where: {
      storeId,
      resourceId,
      AND: [
        { OR: [{ windowUntil: null }, { windowUntil: { lte: deliveredAt } }] },
        {
          OR: [
            { count: { lte: 0 } },
            { countExpiresAt: null },
            { countExpiresAt: { lte: deliveredAt } },
          ],
        },
      ],
    },
  });
  return null;
}

/**
 * Put back a mark consumeSuppression consumed, for a caller that then failed to
 * record the hidden event — so the RETRY of the same delivery can still match.
 * Restores the exact shape consumed (a window keeps its ORIGINAL windowUntil, a
 * count keeps its original expiry). armedAt is restored to the LOOSER of the
 * consumed mark's and the row's (earlier wins; NULL = no lower bound wins over
 * everything) — a fresh arm can interleave between consume and rearm and reset
 * armedAt to now(), which would push the lower bound past the retried delivery
 * and record that echo visibly; the union bound keeps both the retry and the
 * new mark's echoes matching, and is exactly what the two marks covered
 * separately. Retries match even a wall-clock-expired mark because
 * consumeSuppression judges validity against deliveredAt.
 */
export async function rearmSuppression(
  storeId: string,
  resourceId: string,
  mark: ConsumedMark,
): Promise<void> {
  // NULL-aware "earlier of the two": Postgres LEAST ignores NULLs, which would
  // wrongly TIGHTEN a no-lower-bound mark, so NULL on either side must win.
  if (mark.kind === "window") {
    // A window match doesn't decrement anything, so the row is usually intact —
    // restore windowUntil (never a count) in case it was cleaned up meanwhile.
    await prisma.$executeRaw`
      INSERT INTO "RevertSuppression" ("storeId", "resourceId", "windowUntil", "armedAt", "updatedAt")
      VALUES (${storeId}, ${resourceId}, ${mark.until}, ${mark.armedAt}, now())
      ON CONFLICT ("storeId", "resourceId") DO UPDATE
      SET "windowUntil" = GREATEST(COALESCE("RevertSuppression"."windowUntil", EXCLUDED."windowUntil"), EXCLUDED."windowUntil"),
          "armedAt" = CASE
            WHEN "RevertSuppression"."armedAt" IS NULL OR EXCLUDED."armedAt" IS NULL THEN NULL
            ELSE LEAST("RevertSuppression"."armedAt", EXCLUDED."armedAt")
          END,
          "updatedAt" = now()`;
    return;
  }
  // Undo the decrement, keeping the ORIGINAL expiry (GREATEST: never shorten a
  // newer mark armed since we consumed).
  await prisma.$executeRaw`
    INSERT INTO "RevertSuppression" ("storeId", "resourceId", "count", "countExpiresAt", "armedAt", "updatedAt")
    VALUES (${storeId}, ${resourceId}, 1, ${mark.expiresAt}, ${mark.armedAt}, now())
    ON CONFLICT ("storeId", "resourceId") DO UPDATE
    SET "count" = "RevertSuppression"."count" + 1,
        "countExpiresAt" = GREATEST(COALESCE("RevertSuppression"."countExpiresAt", EXCLUDED."countExpiresAt"), EXCLUDED."countExpiresAt"),
        "armedAt" = CASE
          WHEN "RevertSuppression"."armedAt" IS NULL OR EXCLUDED."armedAt" IS NULL THEN NULL
          ELSE LEAST("RevertSuppression"."armedAt", EXCLUDED."armedAt")
        END,
        "updatedAt" = now()`;
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

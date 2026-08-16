import cron, { type ScheduledTask } from "node-cron";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runBackup, deleteBackupBlobs } from "./backup.server";
import { storage } from "./storage.server";
import type { BackupInterval } from "@prisma/client";

/**
 * Returns the number of milliseconds for a given BackupInterval.
 */
function intervalToMs(interval: BackupInterval): number {
  switch (interval) {
    case "EVERY_6H":
      return 6 * 60 * 60 * 1000;
    case "EVERY_12H":
      return 12 * 60 * 60 * 1000;
    case "DAILY":
      return 24 * 60 * 60 * 1000;
    case "WEEKLY":
      return 7 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Computes the next run time strictly after `from`, anchored to the store's
 * autoBackupHour (UTC) so the configured backup time is honored instead of
 * drifting with each run:
 * - DAILY: next occurrence of that UTC hour
 * - EVERY_6H / EVERY_12H: next 6h/12h boundary offset from that hour
 * - WEEKLY: next occurrence of that hour on the weekday given by
 *   `weeklyAnchor` — a UTC weekday number (schedule.weeklyDay) or, for rows
 *   that predate weeklyDay, a Date whose UTC weekday is used; falls back to
 *   `from`'s weekday
 */
function computeNextRunAt(
  interval: BackupInterval,
  anchorHourUTC: number,
  from: Date = new Date(),
  weeklyAnchor?: Date | number | null,
): Date {
  if (interval === "DAILY") {
    const next = new Date(from);
    next.setUTCHours(anchorHourUTC, 0, 0, 0);
    if (next <= from) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  if (interval === "WEEKLY") {
    const targetWeekday =
      typeof weeklyAnchor === "number"
        ? weeklyAnchor
        : (weeklyAnchor ?? from).getUTCDay();
    const next = new Date(from);
    next.setUTCHours(anchorHourUTC, 0, 0, 0);
    next.setUTCDate(next.getUTCDate() + ((targetWeekday - next.getUTCDay() + 7) % 7));
    if (next <= from) {
      next.setUTCDate(next.getUTCDate() + 7);
    }
    return next;
  }

  // Sub-daily intervals (6h, 12h): next boundary anchored to autoBackupHour
  const msInterval = intervalToMs(interval);
  const anchor = new Date(from);
  anchor.setUTCHours(anchorHourUTC, 0, 0, 0);
  if (anchor > from) {
    // Step back a day so boundaries earlier in the current UTC day are covered
    anchor.setUTCDate(anchor.getUTCDate() - 1);
  }
  const elapsed = from.getTime() - anchor.getTime();
  const periodsElapsed = Math.floor(elapsed / msInterval) + 1;
  return new Date(anchor.getTime() + periodsElapsed * msInterval);
}

/**
 * Computes a reasonable initial nextRunAt for a store that has no schedule yet,
 * based on the store's autoBackupHour and the chosen interval.
 */
function computeInitialNextRunAt(
  autoBackupHour: number,
  interval: BackupInterval,
): Date {
  return computeNextRunAt(interval, autoBackupHour, new Date());
}

/**
 * Processes a single store's scheduled backup. Returns true on success.
 * On failure, makes sure a FAILED Backup row exists so the dashboard shows
 * the failure instead of a silently healthy schedule.
 */
async function processStoreBackup(storeId: string, plan: string): Promise<boolean> {
  console.log(`[Scheduler] Starting scheduled backup for store: ${storeId}`);
  const startedAt = new Date();

  try {
    const { admin } = await unauthenticated.admin(storeId);
    await runBackup(admin, storeId, "SCHEDULED", plan);
    console.log(`[Scheduler] Completed scheduled backup for store: ${storeId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Scheduler] Failed backup for store ${storeId}: ${message}`,
    );

    // runBackup marks its own row FAILED; if it never got far enough to
    // create one (e.g. dead offline session), record the failure here.
    try {
      const existing = await prisma.backup.findFirst({
        where: { storeId, trigger: "SCHEDULED", createdAt: { gte: startedAt } },
      });
      if (!existing) {
        await prisma.backup.create({
          data: {
            storeId,
            trigger: "SCHEDULED",
            status: "FAILED",
            errorMessage: message,
          },
        });
      }
    } catch (recordError) {
      console.error(
        `[Scheduler] Could not record failed backup for ${storeId}:`,
        recordError,
      );
    }
    return false;
  }
}

/**
 * Marks backups stuck PENDING/IN_PROGRESS (crash or restart mid-run) as
 * FAILED so they don't freeze the dashboard or block new runs forever, and
 * cleans up whatever blobs they already wrote.
 */
async function failStalledBackups(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 30 * 60 * 1000);
  const stalled = await prisma.backup.findMany({
    where: {
      status: { in: ["PENDING", "IN_PROGRESS"] },
      updatedAt: { lt: cutoff },
    },
  });

  for (const backup of stalled) {
    // Conditional write: re-checks the row is STILL stalled at update time.
    // A live run heartbeats Backup.updatedAt (backup.server.ts) and completes
    // via a status-guarded update, so if it heartbeated or finished between
    // the findMany above and this write, count is 0 and we must not touch it
    // (an unguarded update here would fail a live/COMPLETED backup and delete
    // its blobs).
    const swept = await prisma.backup.updateMany({
      where: {
        id: backup.id,
        status: { in: ["PENDING", "IN_PROGRESS"] },
        updatedAt: { lt: cutoff },
      },
      data: {
        status: "FAILED",
        errorMessage: "Stalled - process restarted mid-backup",
      },
    });
    if (swept.count === 0) continue;
    console.warn(
      `[Scheduler] Backup ${backup.id} stalled in ${backup.status}; marked FAILED`,
    );
    await deleteBackupBlobs(backup.storeId, backup.id);
  }
}

/**
 * Applies retention shrinks whose grace period has elapsed.
 *
 * A downgrade or lapsed subscription stages the smaller window instead of
 * applying it (see planTransition in app/routes/app.settings.tsx), so the
 * merchant keeps their history long enough to notice and resubscribe. Once
 * pendingRetentionAt passes, the shrink lands here and the sweep below starts
 * enforcing it. Prisma can't copy a column to another column in updateMany,
 * hence the per-store update.
 */
async function applyDueRetentionChanges(now: Date): Promise<void> {
  const due = await prisma.store.findMany({
    where: {
      pendingRetentionAt: { lte: now },
      pendingRetentionDays: { not: null },
    },
    select: { id: true, pendingRetentionDays: true, retentionDays: true },
  });

  for (const store of due) {
    if (store.pendingRetentionDays === null) continue;
    try {
      await prisma.store.update({
        where: { id: store.id },
        data: {
          retentionDays: store.pendingRetentionDays,
          pendingRetentionDays: null,
          pendingRetentionAt: null,
        },
      });
      console.log(
        `[Scheduler] Retention grace elapsed for ${store.id}: ` +
          `${store.retentionDays}d -> ${store.pendingRetentionDays}d`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Scheduler] Failed to apply retention change for ${store.id}: ${message}`,
      );
    }
  }
}

/**
 * Enforces each store's retentionDays: deletes COMPLETED/FAILED backups older
 * than the window, always keeping the store's most recent COMPLETED backup
 * (never delete the last good snapshot, no matter how old).
 */
async function enforceRetention(): Promise<void> {
  await applyDueRetentionChanges(new Date());

  const stores = await prisma.store.findMany({
    where: { backups: { some: {} } },
  });

  for (const store of stores) {
    try {
      const cutoff = new Date(Date.now() - store.retentionDays * 24 * 60 * 60 * 1000);
      const lastGood = await prisma.backup.findFirst({
        where: { storeId: store.id, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const expired = await prisma.backup.findMany({
        where: {
          storeId: store.id,
          status: { in: ["COMPLETED", "FAILED"] },
          createdAt: { lt: cutoff },
          ...(lastGood ? { id: { not: lastGood.id } } : {}),
        },
        select: { id: true },
      });

      let deleted = 0;
      for (const backup of expired) {
        // Blobs first; keep the DB row when that fails so the next pass retries
        if (!(await deleteBackupBlobs(store.id, backup.id))) continue;
        await prisma.backup.delete({ where: { id: backup.id } });
        deleted++;
      }

      if (deleted > 0) {
        console.log(
          `[Scheduler] Retention: deleted ${deleted} backup(s) older than ${store.retentionDays}d for ${store.id}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Scheduler] Retention failed for ${store.id}: ${message}`);
    }
  }
}

// Fallback erasure for churned shops whose shop/redact webhook never arrived.
// Shopify sends shop/redact ~48h after uninstall; if delivery failed for good,
// the shop's blobs and rows would otherwise persist forever. A reinstall
// clears uninstalledAt (afterAuth), so active stores are never purged.
const UNINSTALL_PURGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes all data for stores uninstalled more than UNINSTALL_PURGE_MS ago,
 * mirroring the shop/redact handler (blobs first — the DB rows are the only
 * index into them; the Store row is kept on failure so the next pass retries).
 */
async function purgeUninstalledStores(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - UNINSTALL_PURGE_MS);
  const stores = await prisma.store.findMany({
    where: { uninstalledAt: { lte: cutoff } },
    select: { id: true, uninstalledAt: true },
  });

  for (const store of stores) {
    try {
      // Re-check right before the slow blob sweep: a reinstall since the
      // findMany snapshot (afterAuth nulls uninstalledAt) must not be purged.
      // Earlier stores' sweeps can take minutes, so the snapshot goes stale.
      const current = await prisma.store.findUnique({
        where: { id: store.id },
        select: { uninstalledAt: true },
      });
      if (!current?.uninstalledAt || current.uninstalledAt > cutoff) {
        console.log(
          `[Scheduler] Skipping purge for ${store.id} — reinstalled since the purge scan`,
        );
        continue;
      }
      await storage.deletePrefix(`${store.id}/`);
      await prisma.changeLog.deleteMany({ where: { storeId: store.id } });
      await prisma.webhookEvent.deleteMany({ where: { storeId: store.id } });
      await prisma.revertSuppression.deleteMany({
        where: { storeId: store.id },
      });
      await prisma.backupItem.deleteMany({
        where: { backup: { storeId: store.id } },
      });
      await prisma.backup.deleteMany({ where: { storeId: store.id } });
      await prisma.backupSchedule.deleteMany({ where: { storeId: store.id } });
      await prisma.session.deleteMany({ where: { shop: store.id } });
      // Conditional: a reinstall mid-purge nulls uninstalledAt, so the Store
      // row survives and afterAuth can rebuild what the sweep already removed.
      await prisma.store.deleteMany({
        where: { id: store.id, uninstalledAt: { lte: cutoff } },
      });
      console.log(
        `[Scheduler] Purged all data for ${store.id} (uninstalled ${store.uninstalledAt?.toISOString()}, no shop/redact received)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Scheduler] Uninstall purge failed for ${store.id}: ${message}`,
      );
    }
  }
}

// Guards against a tick overlapping a still-running previous tick (a >60s
// backup would otherwise be started again by the next cron fire).
let tickInFlight = false;

// Retention runs at most once per hour, not on every tick
let lastRetentionAt = 0;

/**
 * The main tick function that runs every minute.
 * Finds all stores due for a backup and processes them.
 */
async function schedulerTick(): Promise<void> {
  if (tickInFlight) {
    console.log("[Scheduler] Previous tick still running, skipping");
    return;
  }
  tickInFlight = true;
  const now = new Date();

  try {
    await failStalledBackups(now);

    if (Date.now() - lastRetentionAt >= 60 * 60 * 1000) {
      lastRetentionAt = Date.now();
      await enforceRetention();
      await purgeUninstalledStores(now);
    }

    // Find all stores with auto-backup enabled that have a schedule whose
    // nextRunAt is in the past (or null, meaning never scheduled).
    const dueStores = await prisma.store.findMany({
      where: {
        autoBackupEnabled: true,
        backupSchedules: {
          some: {
            enabled: true,
            OR: [
              { nextRunAt: { lte: now } },
              { nextRunAt: null },
            ],
          },
        },
      },
      include: {
        backupSchedules: {
          where: { enabled: true },
        },
      },
    });

    if (dueStores.length === 0) {
      return;
    }

    console.log(
      `[Scheduler] Found ${dueStores.length} store(s) due for backup`,
    );

    // Process each store sequentially to avoid overwhelming the API
    for (const store of dueStores) {
      const schedule = store.backupSchedules[0];
      if (!schedule) continue;

      // Don't start on top of a backup that's already running (e.g. manual);
      // the schedule stays due, so it retries on a later tick.
      const active = await prisma.backup.findFirst({
        where: {
          storeId: store.id,
          status: { in: ["PENDING", "IN_PROGRESS"] },
        },
      });
      if (active) {
        console.log(
          `[Scheduler] Skipping ${store.id}: backup ${active.id} is ${active.status}`,
        );
        continue;
      }

      const succeeded = await processStoreBackup(store.id, store.plan);
      const runTime = new Date();

      if (succeeded) {
        // Anchor to the store's configured backup hour so the time never
        // drifts. The weekday comes from weeklyDay, NOT from the timestamps:
        // the failure path below overwrites nextRunAt with hourly retry
        // times, and a recovery run's lastRunAt is whenever the retry finally
        // succeeded — either can sit on a different UTC weekday than the
        // schedule's real run day. The timestamp fallback only serves rows
        // created before weeklyDay existed.
        const nextRunAt = computeNextRunAt(
          schedule.interval,
          store.autoBackupHour,
          runTime,
          schedule.weeklyDay ?? schedule.nextRunAt ?? schedule.lastRunAt,
        );

        await prisma.backupSchedule.update({
          where: { id: schedule.id },
          data: {
            lastRunAt: runTime,
            nextRunAt,
            // Lock in the WEEKLY run day (nextRunAt lands on the anchor
            // weekday); this also backfills rows that predate weeklyDay.
            ...(schedule.interval === "WEEKLY"
              ? { weeklyDay: nextRunAt.getUTCDay() }
              : {}),
          },
        });

        console.log(
          `[Scheduler] Next backup for ${store.id} scheduled at ${nextRunAt.toISOString()}`,
        );
      } else {
        // Retry in an hour instead of silently waiting out the full interval
        const nextRunAt = new Date(runTime.getTime() + 60 * 60 * 1000);

        await prisma.backupSchedule.update({
          where: { id: schedule.id },
          data: {
            nextRunAt,
            // Legacy WEEKLY row without weeklyDay: capture the weekday of the
            // slot that just fired before this retry timestamp erases it.
            ...(schedule.interval === "WEEKLY" &&
            schedule.weeklyDay === null &&
            schedule.nextRunAt
              ? { weeklyDay: schedule.nextRunAt.getUTCDay() }
              : {}),
          },
        });

        console.log(
          `[Scheduler] Backup for ${store.id} failed; retrying at ${nextRunAt.toISOString()}`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Scheduler] Tick error: ${message}`);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Ensures all stores with autoBackupEnabled have a BackupSchedule record.
 * Creates one with sensible defaults if missing.
 */
async function ensureSchedulesExist(): Promise<void> {
  try {
    const storesWithoutSchedule = await prisma.store.findMany({
      where: {
        autoBackupEnabled: true,
        backupSchedules: { none: {} },
      },
    });

    for (const store of storesWithoutSchedule) {
      const nextRunAt = computeInitialNextRunAt(store.autoBackupHour, "DAILY");

      await prisma.backupSchedule.create({
        data: {
          storeId: store.id,
          enabled: true,
          interval: "DAILY",
          cronExpr: `0 ${store.autoBackupHour} * * *`,
          nextRunAt,
        },
      });

      console.log(
        `[Scheduler] Created schedule for store ${store.id}, next run at ${nextRunAt.toISOString()}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Scheduler] Error ensuring schedules exist: ${message}`);
  }
}

let cronTask: ScheduledTask | null = null;

/**
 * Starts the backup scheduler. Runs a check every minute.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
export function startScheduler(): void {
  if (cronTask) {
    console.log("[Scheduler] Already running, skipping start");
    return;
  }

  console.log("[Scheduler] Starting backup scheduler (checking every minute)");

  // On startup, ensure all enabled stores have schedule records
  ensureSchedulesExist().catch((err) => {
    console.error("[Scheduler] Failed to ensure schedules on startup:", err);
  });

  // Run the tick every minute
  cronTask = cron.schedule("* * * * *", () => {
    schedulerTick().catch((err) => {
      console.error("[Scheduler] Unhandled error in tick:", err);
    });
  });
}

/**
 * Stops the backup scheduler.
 */
export function stopScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log("[Scheduler] Stopped backup scheduler");
  }
}

// Export helpers for testing and manual use
export { computeNextRunAt, computeInitialNextRunAt, intervalToMs };

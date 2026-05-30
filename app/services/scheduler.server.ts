import cron, { type ScheduledTask } from "node-cron";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runBackup } from "./backup.server";
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
 * Computes the next run time from the given base time and interval.
 */
function computeNextRunAt(fromTime: Date, interval: BackupInterval): Date {
  return new Date(fromTime.getTime() + intervalToMs(interval));
}

/**
 * Computes a reasonable initial nextRunAt for a store that has no schedule yet,
 * based on the store's autoBackupHour and the chosen interval.
 */
function computeInitialNextRunAt(
  autoBackupHour: number,
  interval: BackupInterval,
): Date {
  const now = new Date();

  if (interval === "DAILY" || interval === "WEEKLY") {
    // Schedule for the next occurrence of autoBackupHour UTC
    const next = new Date(now);
    next.setUTCHours(autoBackupHour, 0, 0, 0);
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    if (interval === "WEEKLY") {
      // Advance to the same weekday as today (i.e., next week if already past)
      const daysUntilNextWeek = next <= now ? 7 : 0;
      next.setUTCDate(next.getUTCDate() + daysUntilNextWeek);
    }
    return next;
  }

  // For sub-daily intervals (6h, 12h), start from the next interval boundary
  const msInterval = intervalToMs(interval);
  const todayStart = new Date(now);
  todayStart.setUTCHours(autoBackupHour, 0, 0, 0);
  if (todayStart > now) {
    return todayStart;
  }

  // Find the next interval slot after now, anchored to autoBackupHour
  const elapsed = now.getTime() - todayStart.getTime();
  const periodsElapsed = Math.ceil(elapsed / msInterval);
  return new Date(todayStart.getTime() + periodsElapsed * msInterval);
}

/**
 * Processes a single store's scheduled backup.
 */
async function processStoreBackup(storeId: string, plan: string): Promise<void> {
  console.log(`[Scheduler] Starting scheduled backup for store: ${storeId}`);

  try {
    const { admin } = await unauthenticated.admin(storeId);
    await runBackup(admin, storeId, "SCHEDULED", plan);
    console.log(`[Scheduler] Completed scheduled backup for store: ${storeId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Scheduler] Failed backup for store ${storeId}: ${message}`,
    );
  }
}

/**
 * The main tick function that runs every minute.
 * Finds all stores due for a backup and processes them.
 */
async function schedulerTick(): Promise<void> {
  const now = new Date();

  try {
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

      await processStoreBackup(store.id, store.plan);

      // Update schedule timestamps
      const runTime = new Date();
      const nextRunAt = computeNextRunAt(runTime, schedule.interval);

      await prisma.backupSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: runTime,
          nextRunAt,
        },
      });

      console.log(
        `[Scheduler] Next backup for ${store.id} scheduled at ${nextRunAt.toISOString()}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Scheduler] Tick error: ${message}`);
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

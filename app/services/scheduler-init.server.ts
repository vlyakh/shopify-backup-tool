import { startScheduler } from "./scheduler.server";
import { startWebhookProcessor } from "./webhook-queue.server";

/**
 * Self-executing module that starts background services on import.
 * Import this from entry.server.tsx to kick off at server boot:
 * - Backup scheduler (checks every minute for stores due for backup)
 * - Webhook queue processor (processes webhook events every 10 seconds)
 */

let initialized = false;

export function initScheduler(): void {
  if (initialized) return;
  initialized = true;

  // Scale-out guard: the cron scheduler and webhook processor claim work
  // non-atomically, so only ONE instance may run them. Defaults ON; extra
  // instances (scale-out, warm staging slots) set ENABLE_BACKGROUND_JOBS=false.
  const jobsFlag = process.env.ENABLE_BACKGROUND_JOBS?.trim().toLowerCase();
  if (jobsFlag === "false" || jobsFlag === "0") {
    console.log(
      "[SchedulerInit] ENABLE_BACKGROUND_JOBS is disabled — skipping background jobs on this instance"
    );
    return;
  }

  // Delay startup slightly to let the server finish initializing
  setTimeout(() => {
    console.log("[SchedulerInit] Initializing backup scheduler...");
    startScheduler();

    console.log("[SchedulerInit] Initializing webhook queue processor...");
    startWebhookProcessor();
  }, 5000);
}

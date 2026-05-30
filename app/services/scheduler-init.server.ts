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

  // Delay startup slightly to let the server finish initializing
  setTimeout(() => {
    console.log("[SchedulerInit] Initializing backup scheduler...");
    startScheduler();

    console.log("[SchedulerInit] Initializing webhook queue processor...");
    startWebhookProcessor();
  }, 5000);
}

import cron, { type ScheduledTask } from "node-cron";
import prisma from "../db.server";
import { recordChange } from "./changelog.server";
import type { ResourceType, ChangeAction } from "@prisma/client";
import { storage } from "./storage.server";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;

/**
 * Fields on the product payload that change with every inventory adjustment.
 * When these are the ONLY fields that differ, we skip recording the change.
 */
const INVENTORY_FIELDS = new Set([
  "inventory_quantity",
  "old_inventory_quantity",
  "inventory_policy",
  "inventory_management",
  "updated_at",
  "published_at",
]);

/**
 * Variant-level fields that change with inventory adjustments.
 */
const VARIANT_INVENTORY_FIELDS = new Set([
  "inventory_quantity",
  "old_inventory_quantity",
  "inventory_item_id",
  "inventory_management",
  "inventory_policy",
  "updated_at",
]);

// ─── Fast Intake ────────────────────────────────────────────────────────────

/**
 * Enqueue a webhook event for background processing.
 * This is the FAST path — insert into DB and return immediately.
 * Called from webhook handlers to ensure we return 200 within Shopify's timeout.
 */
export async function enqueueWebhook(
  storeId: string,
  topic: string,
  resourceType: ResourceType,
  resourceId: string,
  action: ChangeAction,
  payload: unknown,
): Promise<void> {
  await prisma.webhookEvent.create({
    data: {
      storeId,
      topic,
      resourceType,
      resourceId,
      action,
      payload: JSON.stringify(payload),
    },
  });
}

// ─── Inventory-Only Detection ───────────────────────────────────────────────

/**
 * Strip inventory-related fields from a product payload for comparison.
 * Returns a cleaned copy without fields that change on every order.
 */
function stripInventoryFields(product: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(product)) {
    if (INVENTORY_FIELDS.has(key)) continue;

    if (key === "variants" && Array.isArray(value)) {
      cleaned[key] = value.map((variant: Record<string, unknown>) => {
        const cleanedVariant: Record<string, unknown> = {};
        for (const [vKey, vValue] of Object.entries(variant)) {
          if (!VARIANT_INVENTORY_FIELDS.has(vKey)) {
            cleanedVariant[vKey] = vValue;
          }
        }
        return cleanedVariant;
      });
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

/**
 * Check if a product update is inventory-only by comparing against the last snapshot.
 * Returns true if the only changes are inventory-related fields.
 */
async function isInventoryOnlyChange(
  storeId: string,
  resourceId: string,
  newPayload: Record<string, unknown>,
): Promise<boolean> {
  // Find the last recorded state for this resource
  const lastChange = await prisma.changeLog.findFirst({
    where: { storeId, resourceType: "PRODUCT", resourceId },
    orderBy: { changedAt: "desc" },
  });

  if (!lastChange?.afterPath) {
    // No previous state — this is effectively a first observation, record it
    return false;
  }

  const beforeData = await storage.get(lastChange.afterPath);
  if (!beforeData) return false;

  const before = JSON.parse(beforeData);

  // Strip inventory fields from both and compare
  const cleanedBefore = stripInventoryFields(before);
  const cleanedAfter = stripInventoryFields(newPayload);

  return JSON.stringify(cleanedBefore) === JSON.stringify(cleanedAfter);
}

// ─── Background Processor ───────────────────────────────────────────────────

/**
 * Process a single webhook event from the queue.
 */
async function processEvent(event: {
  id: string;
  storeId: string;
  resourceType: ResourceType;
  resourceId: string;
  action: ChangeAction;
  payload: string;
  attempts: number;
}): Promise<void> {
  const payload = JSON.parse(event.payload);

  // For product updates, check if this is an inventory-only change
  if (event.resourceType === "PRODUCT" && event.action === "UPDATED") {
    const inventoryOnly = await isInventoryOnlyChange(
      event.storeId,
      event.resourceId,
      payload,
    );

    if (inventoryOnly) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: "SKIPPED", processedAt: new Date() },
      });
      return;
    }
  }

  // Process the change through the normal changelog pipeline
  await recordChange(
    event.storeId,
    event.resourceType,
    event.resourceId,
    event.action,
    payload,
  );

  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: { status: "COMPLETED", processedAt: new Date() },
  });
}

/**
 * Main processor tick — picks up pending events and processes them.
 * Runs every 10 seconds for near-real-time processing.
 */
async function processorTick(): Promise<void> {
  try {
    // Claim a batch of pending events by marking them PROCESSING
    const pending = await prisma.webhookEvent.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) return;

    // Mark batch as PROCESSING to prevent double-processing
    const ids = pending.map((e) => e.id);
    await prisma.webhookEvent.updateMany({
      where: { id: { in: ids } },
      data: { status: "PROCESSING" },
    });

    for (const event of pending) {
      try {
        await processEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const newAttempts = event.attempts + 1;

        if (newAttempts >= MAX_ATTEMPTS) {
          // Move to DLQ
          await prisma.webhookEvent.update({
            where: { id: event.id },
            data: {
              status: "FAILED",
              attempts: newAttempts,
              lastError: message,
              processedAt: new Date(),
            },
          });
          console.error(
            `[WebhookQueue] Event ${event.id} moved to DLQ after ${newAttempts} attempts: ${message}`,
          );
        } else {
          // Put back to PENDING for retry
          await prisma.webhookEvent.update({
            where: { id: event.id },
            data: {
              status: "PENDING",
              attempts: newAttempts,
              lastError: message,
            },
          });
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebhookQueue] Processor tick error: ${message}`);
  }
}

/**
 * Cleanup old processed events to prevent table bloat.
 * Keeps failed events (DLQ) for investigation, removes completed/skipped older than 7 days.
 */
async function cleanupProcessedEvents(): Promise<void> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  try {
    const { count } = await prisma.webhookEvent.deleteMany({
      where: {
        status: { in: ["COMPLETED", "SKIPPED"] },
        processedAt: { lt: sevenDaysAgo },
      },
    });

    if (count > 0) {
      console.log(`[WebhookQueue] Cleaned up ${count} old processed events`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebhookQueue] Cleanup error: ${message}`);
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let processorTask: ScheduledTask | null = null;
let cleanupTask: ScheduledTask | null = null;

/**
 * Start the webhook queue processor.
 * - Processes pending events every 10 seconds
 * - Cleans up old events daily at midnight
 */
export function startWebhookProcessor(): void {
  if (processorTask) {
    console.log("[WebhookQueue] Processor already running, skipping start");
    return;
  }

  console.log("[WebhookQueue] Starting webhook queue processor (every 10s)");

  // Process queue every 10 seconds
  processorTask = cron.schedule("*/10 * * * * *", () => {
    processorTick().catch((err) => {
      console.error("[WebhookQueue] Unhandled processor error:", err);
    });
  });

  // Cleanup old events daily at midnight UTC
  cleanupTask = cron.schedule("0 0 * * *", () => {
    cleanupProcessedEvents().catch((err) => {
      console.error("[WebhookQueue] Unhandled cleanup error:", err);
    });
  });
}

/**
 * Stop the webhook queue processor.
 */
export function stopWebhookProcessor(): void {
  if (processorTask) {
    processorTask.stop();
    processorTask = null;
  }
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
  }
  console.log("[WebhookQueue] Stopped webhook queue processor");
}

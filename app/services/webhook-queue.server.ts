import cron, { type ScheduledTask } from "node-cron";
import prisma from "../db.server";
import { recordChange } from "./changelog.server";
import type { ResourceType, ChangeAction } from "@prisma/client";
import { storage } from "./storage.server";
import { consumeSuppression, markHidden } from "./revert-bookkeeping.server";
import {
  rememberInventoryItem,
  lookupInventoryItem,
} from "./inventory-map.server";
import { unauthenticated } from "../shopify.server";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;

/**
 * Fields on the product payload that change with every inventory adjustment.
 * When these are the ONLY fields that differ, we skip recording the change.
 */
const INVENTORY_FIELDS = new Set([
  "inventory_quantity",
  "old_inventory_quantity",
  "updated_at",
  // NOT here (so they record, not treated as inventory noise): published_at
  // (Online Store publish), inventory_policy (continue selling) and
  // inventory_management (track quantity) — deliberate merchant settings.
]);

/**
 * Variant-level fields that change with inventory adjustments (quantity only).
 */
const VARIANT_INVENTORY_FIELDS = new Set([
  "inventory_quantity",
  "old_inventory_quantity",
  "inventory_item_id",
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

// ─── Inventory item (cost) ──────────────────────────────────────────────────

/**
 * Cold-miss fallback: resolve an inventory item's product + variant via one
 * GraphQL lookup when it isn't in the in-memory map yet (e.g. right after a
 * redeploy). Steady state this never runs — the map is filled from product
 * webhooks.
 */
async function fetchInventoryMapping(
  storeId: string,
  inventoryGid: string,
): Promise<{ productId: string; variantId: string } | null> {
  try {
    const { admin } = await unauthenticated.admin(storeId);
    const resp = await admin.graphql(
      `#graphql
      query($id: ID!) {
        inventoryItem(id: $id) { variant { id product { id } } }
      }`,
      { variables: { id: inventoryGid } },
    );
    const variant = (
      (await resp.json()) as {
        data?: { inventoryItem?: { variant?: { id?: string; product?: { id?: string } } } };
      }
    ).data?.inventoryItem?.variant;
    if (variant?.id && variant.product?.id) {
      return { productId: variant.product.id, variantId: variant.id };
    }
  } catch (error) {
    console.error(`[InventoryMap] lookup failed for ${inventoryGid}:`, error);
  }
  return null;
}

// InventoryItem fields not in the product payload (REST keys). We keep their
// current state per variant and diff old -> new on each inventory webhook.
const INVENTORY_TRACKED = [
  "cost",
  "harmonized_system_code",
  "country_code_of_origin",
];

/**
 * Record a cost change from an inventory_items/update webhook. The product
 * payload never carries cost, so we track it separately: keep the current cost
 * per variant in storage, and when it changes write a minimal variant-shaped
 * before/after blob + a ChangeLog row. The history's existing variant diff then
 * renders it as a "Cost per item" change (cost is in VARIANT_FIELDS), and undo
 * reverts it via inventoryItem.cost — same path as the other variant fields.
 */
async function handleInventoryItemUpdate(
  storeId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store?.webhooksEnabled) return;

  const inventoryGid = String(payload.admin_graphql_api_id);
  let mapping = lookupInventoryItem(inventoryGid);
  if (!mapping) {
    mapping = await fetchInventoryMapping(storeId, inventoryGid);
    if (mapping) {
      rememberInventoryItem(inventoryGid, mapping.productId, mapping.variantId);
    }
  }
  if (!mapping) return; // can't attribute to a product — skip

  const statePath = `${storeId}/state/inventory/${encodeURIComponent(mapping.variantId)}.json`;
  let prev: Record<string, string | null> = {};
  try {
    const raw = await storage.get(statePath);
    if (raw) prev = JSON.parse(raw) as Record<string, string | null>;
  } catch {
    prev = {};
  }
  const next: Record<string, string | null> = {};
  let changed = false;
  for (const field of INVENTORY_TRACKED) {
    const v = payload[field] != null ? String(payload[field]) : null;
    next[field] = v;
    if (String(prev[field] ?? "") !== String(v ?? "")) changed = true;
  }
  if (!changed) return; // none of the tracked fields changed

  const ts = Date.now();
  const enc = encodeURIComponent(mapping.productId);
  const before = {
    variants: [{ admin_graphql_api_id: mapping.variantId, ...prev }],
  };
  const after = {
    variants: [{ admin_graphql_api_id: mapping.variantId, ...next }],
  };
  const beforePath = `${storeId}/changes/PRODUCT/${enc}/${ts}-inv-before.json`;
  const afterPath = `${storeId}/changes/PRODUCT/${enc}/${ts}-inv-after.json`;
  await storage.put(beforePath, JSON.stringify(before, null, 2));
  await storage.put(afterPath, JSON.stringify(after, null, 2));

  const created = await prisma.changeLog.create({
    data: {
      storeId,
      resourceType: "PRODUCT",
      resourceId: mapping.productId,
      action: "UPDATED",
      beforePath,
      afterPath,
      changedFields: ["variants"],
    },
  });
  // A cost revert WE made re-fires inventory_items/update — record but hide it,
  // same as product reverts, so it doesn't resurface as a new row.
  if (consumeSuppression(mapping.productId)) markHidden(created.id);

  await storage.put(statePath, JSON.stringify(next));
}

// ─── Background Processor ───────────────────────────────────────────────────

/**
 * Process a single webhook event from the queue.
 */
async function processEvent(event: {
  id: string;
  storeId: string;
  topic: string;
  resourceType: ResourceType;
  resourceId: string;
  action: ChangeAction;
  payload: string;
  attempts: number;
}): Promise<void> {
  const payload = JSON.parse(event.payload);

  // Inventory item updated — a cost change. Attribute it to a product and record
  // it on its own (the product payload never carries cost).
  if (event.topic === "inventory_items/update") {
    await handleInventoryItemUpdate(event.storeId, payload);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    return;
  }

  // Keep the inventory_item_id → product/variant map warm from product payloads,
  // so inventory_items/update can attribute cost changes without a lookup.
  if (event.resourceType === "PRODUCT" && Array.isArray(payload.variants)) {
    const productGid = String(payload.admin_graphql_api_id);
    for (const v of payload.variants as Array<Record<string, unknown>>) {
      if (v?.inventory_item_id && v?.admin_graphql_api_id) {
        rememberInventoryItem(
          `gid://shopify/InventoryItem/${v.inventory_item_id}`,
          productGid,
          String(v.admin_graphql_api_id),
        );
      }
    }
  }

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

  // Record the change. A revert/undo WE made is recorded too — so the baseline
  // advances and the next real edit diffs correctly — but flagged hidden so it
  // doesn't surface in the history (skipping it would leave a stale baseline that
  // resurfaces every reverted field on the next edit).
  const hide =
    event.resourceType === "PRODUCT" &&
    event.action === "UPDATED" &&
    consumeSuppression(event.resourceId);
  const eventId = await recordChange(
    event.storeId,
    event.resourceType,
    event.resourceId,
    event.action,
    payload,
  );
  if (hide && eventId) markHidden(eventId);

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

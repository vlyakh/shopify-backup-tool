import cron, { type ScheduledTask } from "node-cron";
import prisma from "../db.server";
import { recordChange, findLastFullSnapshot } from "./changelog.server";
import { Prisma } from "@prisma/client";
import type { ResourceType, ChangeAction } from "@prisma/client";
import { storage } from "./storage.server";
import {
  consumeSuppression,
  rearmSuppression,
  cleanupExpiredSuppressions,
  type ConsumedMark,
} from "./revert-bookkeeping.server";
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
 * `webhookId` is Shopify's X-Shopify-Webhook-Id: the same delivery redelivered
 * (we timed out, Shopify retried) dedupes on its unique constraint.
 */
export async function enqueueWebhook(
  storeId: string,
  topic: string,
  resourceType: ResourceType,
  resourceId: string,
  action: ChangeAction,
  payload: unknown,
  webhookId?: string,
): Promise<void> {
  try {
    await prisma.webhookEvent.create({
      data: {
        storeId,
        topic,
        resourceType,
        resourceId,
        action,
        payload: JSON.stringify(payload),
        webhookId: webhookId ?? null,
      },
    });
  } catch (error) {
    if (
      webhookId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(
        `[WebhookQueue] Duplicate delivery ${webhookId} (${topic}) already enqueued, skipping`,
      );
      return;
    }
    throw error;
  }
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
  // Find the last recorded FULL state for this resource — never one of our
  // synthetic -inv-/-mf- blobs, or the first inventory-only update after a
  // cost/metafield edit would diff as a visible product change.
  const lastChange = await findLastFullSnapshot(storeId, "PRODUCT", resourceId);

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
 *
 * Returns null only when the item GENUINELY has no variant/product (deleted or
 * untracked). A transient lookup failure THROWS so the queue's retry path
 * handles it — swallowing it would silently drop the cost/weight change.
 */
async function fetchInventoryMapping(
  storeId: string,
  inventoryGid: string,
): Promise<{ productId: string; variantId: string } | null> {
  const { admin } = await unauthenticated.admin(storeId);
  const resp = await admin.graphql(
    `#graphql
    query($id: ID!) {
      inventoryItem(id: $id) { variant { id product { id } } }
    }`,
    { variables: { id: inventoryGid } },
  );
  const body = (await resp.json()) as {
    data?: {
      inventoryItem?: {
        variant?: { id?: string; product?: { id?: string } } | null;
      } | null;
    };
    errors?: unknown;
  };
  if (body.errors) {
    throw new Error(
      `Inventory lookup failed for ${inventoryGid}: ${JSON.stringify(body.errors)}`,
    );
  }
  const variant = body.data?.inventoryItem?.variant;
  if (variant?.id && variant.product?.id) {
    return { productId: variant.product.id, variantId: variant.id };
  }
  return null;
}

// InventoryItem fields not in the product payload (REST keys). We keep their
// current state per variant and diff old -> new on each inventory webhook.
// weight_value/weight_unit are flat fields Shopify added to this webhook (weight
// moved off the variant onto inventoryItem.measurement in 2026-04).
const INVENTORY_TRACKED = [
  "cost",
  "harmonized_system_code",
  "country_code_of_origin",
  "weight_value",
  "weight_unit",
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
  deliveredAt: Date,
  webhookEventId: string,
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
    // Canonicalize the numeric fields ("550.00" → "550", "435.0" → "435") so a
    // value compares equal to the backup seed regardless of trailing-zero
    // formatting; keep string fields (units, codes) verbatim.
    let v = payload[field] != null ? String(payload[field]) : null;
    if ((field === "cost" || field === "weight_value") && v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) v = String(n);
    }
    next[field] = v;
    if (String(prev[field] ?? "") !== String(v ?? "")) changed = true;
  }
  if (!changed) return; // none of the tracked fields changed

  const ts = Date.now();
  const enc = encodeURIComponent(mapping.productId);
  // Always carry the tracked keys in `before` (defaulting to null), so the very
  // first observation of a variant's cost still renders. The history skips
  // variant subfields ABSENT from the before-snapshot (its guard against the
  // backup baseline lacking them) — with `...prev` empty on first sight, cost
  // would be undefined and the first cost change would silently not show.
  const before = {
    variants: [
      {
        admin_graphql_api_id: mapping.variantId,
        ...Object.fromEntries(INVENTORY_TRACKED.map((f) => [f, prev[f] ?? null])),
      },
    ],
  };
  const after = {
    variants: [{ admin_graphql_api_id: mapping.variantId, ...next }],
  };
  const beforePath = `${storeId}/changes/PRODUCT/${enc}/${ts}-inv-before.json`;
  const afterPath = `${storeId}/changes/PRODUCT/${enc}/${ts}-inv-after.json`;
  await storage.put(beforePath, JSON.stringify(before, null, 2));
  await storage.put(afterPath, JSON.stringify(after, null, 2));

  // A cost revert WE made re-fires inventory_items/update — record but hide it,
  // same as product reverts, so it doesn't resurface as a new row. A retry that
  // already recorded this event skips the create (and doesn't burn another
  // mark) but still converges the state blob below.
  const existing = await prisma.changeLog.findFirst({
    where: { webhookEventId },
    select: { id: true },
  });
  if (!existing) {
    const consumed = await consumeSuppression(
      storeId,
      mapping.productId,
      deliveredAt,
    );
    try {
      await prisma.changeLog.create({
        data: {
          storeId,
          resourceType: "PRODUCT",
          resourceId: mapping.productId,
          action: "UPDATED",
          beforePath,
          afterPath,
          changedFields: ["variants"],
          hidden: !!consumed,
          webhookEventId,
        },
      });
    } catch (error) {
      // The mark is consumed but nothing was recorded — put the SAME mark back
      // so the retry still hides this echo.
      if (consumed) await rearmSuppression(storeId, mapping.productId, consumed);
      throw error;
    }
  }

  await storage.put(statePath, JSON.stringify(next));
}

// One metafield in the {shop}/state/metafields/{productId}.json blob (a record
// keyed "namespace|key" of these — the same shape backup.server.ts
// seedMetafieldState writes). `type` is needed to undo a DELETED metafield —
// metafieldsSet requires it when the metafield no longer exists on the product.
type MetafieldStateEntry = {
  namespace: string;
  key: string;
  value: string | null;
  type?: string;
};

/**
 * Parse a metafield state blob into a map keyed "namespace|key". The canonical
 * shape is { "ns|key": {namespace, key, value, type} }. Tolerates the legacy
 * shapes written before `type` was tracked: a bare array of entries and a plain
 * { "ns|key": value } record with string values.
 */
function parseMetafieldState(
  raw: string,
): Map<string, MetafieldStateEntry> {
  const out = new Map<string, MetafieldStateEntry>();
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    for (const e of parsed as Array<Record<string, unknown>>) {
      if (!e || typeof e !== "object") continue;
      const namespace = String(e.namespace ?? "");
      const key = String(e.key ?? "");
      if (!namespace || !key) continue;
      out.set(`${namespace}|${key}`, {
        namespace,
        key,
        value: e.value != null ? String(e.value) : null,
        ...(e.type ? { type: String(e.type) } : {}),
      });
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const [namespace, key] = k.split("|");
      if (!namespace || !key) continue;
      if (v && typeof v === "object") {
        const e = v as { value?: unknown; type?: unknown };
        out.set(k, {
          namespace,
          key,
          value: e.value != null ? String(e.value) : null,
          ...(e.type ? { type: String(e.type) } : {}),
        });
      } else {
        out.set(k, { namespace, key, value: v != null ? String(v) : null });
      }
    }
  }
  return out;
}

/**
 * Record product metafield changes from the dedicated metafields subscription.
 * Keep the current value+type per namespace|key in storage and, when a value
 * changes, write a minimal before/after blob the history renders as
 * "Metafield: key" and undo reverts via metafieldsSet. Fires on every product
 * update, so it no-ops unless a tracked metafield actually changed.
 */
async function handleProductMetafields(
  storeId: string,
  payload: Record<string, unknown>,
  deliveredAt: Date,
  webhookEventId: string,
): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store?.webhooksEnabled) return;

  const productId = String(payload.admin_graphql_api_id);
  const metafields = (payload.metafields ?? []) as Array<Record<string, unknown>>;

  const statePath = `${storeId}/state/metafields/${encodeURIComponent(productId)}.json`;

  const next = new Map<string, MetafieldStateEntry>();
  for (const mf of metafields) {
    const namespace = String(mf.namespace ?? "");
    const key = String(mf.key ?? "");
    if (!namespace || !key) continue;
    const t = (mf.type ?? mf.value_type) as string | undefined;
    next.set(`${namespace}|${key}`, {
      namespace,
      key,
      value: mf.value != null ? String(mf.value) : null,
      ...(t ? { type: String(t) } : {}),
    });
  }
  const nextBlob = JSON.stringify(Object.fromEntries(next));

  // No state file means this product was never covered by a backup (e.g.
  // created after the last one): the payload IS the baseline — seed the state
  // and record nothing, or every existing metafield would show as "Added".
  // An unparseable blob is treated the same (no trustworthy baseline).
  const raw = await storage.get(statePath);
  let prev: Map<string, MetafieldStateEntry> | null = null;
  if (raw != null) {
    try {
      prev = parseMetafieldState(raw);
    } catch {
      prev = null;
    }
  }
  if (prev == null) {
    await storage.put(statePath, nextBlob);
    return;
  }

  const before: Array<Record<string, unknown>> = [];
  const after: Array<Record<string, unknown>> = [];
  for (const k of new Set([...prev.keys(), ...next.keys()])) {
    const p = prev.get(k);
    const n = next.get(k);
    if (String(p?.value ?? "") === String(n?.value ?? "")) continue;
    const namespace = p?.namespace ?? n?.namespace;
    const key = p?.key ?? n?.key;
    // Carry `type` on both sides when known (old state blobs lack it) — undoing
    // a deleted metafield needs it.
    const type = n?.type ?? p?.type;
    before.push({ namespace, key, value: p?.value ?? null, ...(type ? { type } : {}) });
    after.push({ namespace, key, value: n?.value ?? null, ...(type ? { type } : {}) });
  }
  if (after.length === 0) return; // no tracked metafield changed

  const ts = Date.now();
  const enc = encodeURIComponent(productId);
  const beforePath = `${storeId}/changes/PRODUCT/${enc}/${ts}-mf-before.json`;
  const afterPath = `${storeId}/changes/PRODUCT/${enc}/${ts}-mf-after.json`;
  await storage.put(beforePath, JSON.stringify({ metafields: before }, null, 2));
  await storage.put(afterPath, JSON.stringify({ metafields: after }, null, 2));

  // A retry that already recorded this event skips the create (and doesn't
  // burn another suppression mark) but still converges the state blob below.
  const existing = await prisma.changeLog.findFirst({
    where: { webhookEventId },
    select: { id: true },
  });
  if (!existing) {
    const consumed = await consumeSuppression(storeId, productId, deliveredAt);
    try {
      await prisma.changeLog.create({
        data: {
          storeId,
          resourceType: "PRODUCT",
          resourceId: productId,
          action: "UPDATED",
          beforePath,
          afterPath,
          changedFields: ["metafields"],
          hidden: !!consumed,
          webhookEventId,
        },
      });
    } catch (error) {
      // The mark is consumed but nothing was recorded — put the SAME mark back
      // so the retry still hides this echo.
      if (consumed) await rearmSuppression(storeId, productId, consumed);
      throw error;
    }
  }

  await storage.put(statePath, nextBlob);
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
  createdAt: Date;
}): Promise<void> {
  const payload = JSON.parse(event.payload);

  // Inventory item updated — a cost change. Attribute it to a product and record
  // it on its own (the product payload never carries cost).
  if (event.topic === "inventory_items/update") {
    await handleInventoryItemUpdate(
      event.storeId,
      payload,
      event.createdAt,
      event.id,
    );
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    return;
  }

  // Product metafields — from the dedicated metafields subscription.
  if (event.topic === "products/metafields") {
    await handleProductMetafields(
      event.storeId,
      payload,
      event.createdAt,
      event.id,
    );
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
  let consumed: ConsumedMark | null = null;
  if (event.resourceType === "PRODUCT" && event.action === "UPDATED") {
    // A retry that already recorded this event must not burn another
    // suppression mark (recordChange skips the duplicate create itself).
    const already = await prisma.changeLog.findFirst({
      where: { webhookEventId: event.id },
      select: { id: true },
    });
    if (!already) {
      consumed = await consumeSuppression(
        event.storeId,
        event.resourceId,
        event.createdAt,
      );
    }
  }
  try {
    await recordChange(
      event.storeId,
      event.resourceType,
      event.resourceId,
      event.action,
      payload,
      !!consumed,
      event.id,
    );
  } catch (error) {
    // The mark is consumed but nothing was recorded — put the SAME mark back
    // so the retry still hides this echo.
    if (consumed) {
      await rearmSuppression(event.storeId, event.resourceId, consumed);
    }
    throw error;
  }

  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: { status: "COMPLETED", processedAt: new Date() },
  });
}

// How long a claimed row may sit in PROCESSING before it counts as abandoned
// (crash mid-batch). Well above the longest plausible batch.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

// Re-entrancy guard: node-cron fires every 10s regardless of whether the
// previous tick finished; overlapping ticks would record the same product's
// events out of order and corrupt the ledger's diff chain.
let tickInFlight = false;

/**
 * Main processor tick — picks up pending events and processes them.
 * Runs every 10 seconds for near-real-time processing.
 */
async function processorTick(): Promise<void> {
  if (tickInFlight) {
    console.log("[WebhookQueue] Previous tick still running, skipping this tick");
    return;
  }
  tickInFlight = true;
  try {
    // Recover rows stuck in PROCESSING (crash mid-batch): retryable ones go
    // back to PENDING, exhausted ones to the DLQ. NULL claimedAt (rows claimed
    // before the column existed) counts as stale too.
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const staleWhere = {
      status: "PROCESSING" as const,
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
    };
    const dead = await prisma.webhookEvent.updateMany({
      where: { ...staleWhere, attempts: { gte: MAX_ATTEMPTS } },
      data: {
        status: "FAILED",
        lastError: "Stale PROCESSING row recovered after processor crash",
        processedAt: new Date(),
      },
    });
    // Replaying a stale row is only safe while NOTHING newer for the same
    // resource has been processed: webhook payloads are full-state snapshots,
    // so recording an old payload after the ledger baseline advanced would
    // create a phantom reversed-diff ChangeLog row (an "edit" the merchant
    // never made), regress the baseline so the next real edit lies about its
    // before-values, and arm an Undo that writes stale data to the live
    // product. Superseded rows are dropped (SKIPPED) instead — the same net
    // outcome they had before recovery existed (stranded in PROCESSING
    // forever: event lost, diff chain intact), minus the corruption.
    //
    // COMPLETED/SKIPPED rows — the supersession witnesses — are purged after
    // 7 days (cleanupProcessedEvents), so a stale row older than that can
    // never be proven safe to replay: drop it outright. This is the deploy
    // case — rows stranded before claimedAt existed (claimedAt NULL) can be
    // months old, and their products edited many times since.
    const witnessHorizon = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const tooOld = await prisma.webhookEvent.updateMany({
      where: {
        ...staleWhere,
        attempts: { lt: MAX_ATTEMPTS },
        createdAt: { lt: witnessHorizon },
      },
      data: {
        status: "SKIPPED",
        lastError:
          "Stale PROCESSING row dropped: too old to verify it wasn't superseded by a newer event",
        processedAt: new Date(),
      },
    });
    let droppedCount = tooOld.count;
    let recoveredCount = 0;

    const staleRetryable = await prisma.webhookEvent.findMany({
      where: { ...staleWhere, attempts: { lt: MAX_ATTEMPTS } },
      select: {
        id: true,
        storeId: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    for (const row of staleRetryable) {
      // Newer event for the same resource already processed? COMPLETED means
      // the baseline advanced past this payload; SKIPPED means the baseline
      // already matched the newer payload — either way the old payload must
      // not be recorded.
      let superseded = !!(await prisma.webhookEvent.findFirst({
        where: {
          storeId: row.storeId,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          status: { in: ["COMPLETED", "SKIPPED"] },
          createdAt: { gt: row.createdAt },
        },
        select: { id: true },
      }));
      if (!superseded) {
        // Any ChangeLog row recorded since this event arrived also counts as
        // a newer observation — it covers a crash that recorded the newer
        // event but died before flipping it to COMPLETED, and (unlike event
        // rows) ChangeLog has no time-based retention.
        superseded = !!(await prisma.changeLog.findFirst({
          where: {
            storeId: row.storeId,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            changedAt: { gt: row.createdAt },
          },
          select: { id: true },
        }));
      }
      if (superseded) {
        const r = await prisma.webhookEvent.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: {
            status: "SKIPPED",
            lastError:
              "Stale PROCESSING row dropped: superseded by a newer processed event for the same resource",
            processedAt: new Date(),
          },
        });
        droppedCount += r.count;
      } else {
        const r = await prisma.webhookEvent.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: { status: "PENDING" },
        });
        recoveredCount += r.count;
      }
    }
    if (dead.count > 0 || recoveredCount > 0 || droppedCount > 0) {
      console.log(
        `[WebhookQueue] Recovered ${recoveredCount} stale PROCESSING event(s), dropped ${droppedCount} superseded, failed ${dead.count}`,
      );
    }

    // Claim a batch of pending events by marking them PROCESSING
    const pending = await prisma.webhookEvent.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) return;

    // Mark batch as PROCESSING to prevent double-processing. Filter on PENDING
    // so a row grabbed in between isn't claimed twice, and process only the
    // rows actually transitioned — defense-in-depth for scale-out (ordering on
    // one instance is guaranteed by the in-flight flag above).
    const ids = pending.map((e) => e.id);
    const claimed = await prisma.webhookEvent.updateMany({
      where: { id: { in: ids }, status: "PENDING" },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
    let batch = pending;
    if (claimed.count !== pending.length) {
      const stillOurs = await prisma.webhookEvent.findMany({
        where: { id: { in: ids }, status: "PROCESSING" },
        select: { id: true },
      });
      const claimedIds = new Set(stillOurs.map((r) => r.id));
      batch = pending.filter((e) => claimedIds.has(e.id));
    }

    for (const event of batch) {
      try {
        await processEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const newAttempts = event.attempts + 1;

        // The retry bookkeeping itself can fail (row deleted by Reset data /
        // shop redact, transient DB error) — log and move on to the next event
        // rather than abandoning the rest of the claimed batch in PROCESSING.
        try {
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
        } catch (bookkeepingError) {
          console.error(
            `[WebhookQueue] Failed to record retry state for event ${event.id}:`,
            bookkeepingError,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WebhookQueue] Processor tick error: ${message}`);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Cleanup old processed events to prevent table bloat.
 * Completed/skipped rows go after 7 days; failed rows (DLQ — full product JSON
 * payloads) are kept 30 days for investigation, then deleted too.
 */
async function cleanupProcessedEvents(): Promise<void> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

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

    const failed = await prisma.webhookEvent.deleteMany({
      where: {
        status: "FAILED",
        OR: [
          { processedAt: { lt: thirtyDaysAgo } },
          { processedAt: null, createdAt: { lt: thirtyDaysAgo } },
        ],
      },
    });
    if (failed.count > 0) {
      console.log(
        `[WebhookQueue] Cleaned up ${failed.count} old failed (DLQ) events`,
      );
    }

    const stale = await cleanupExpiredSuppressions();
    if (stale > 0) {
      console.log(`[WebhookQueue] Cleaned up ${stale} stale suppression rows`);
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

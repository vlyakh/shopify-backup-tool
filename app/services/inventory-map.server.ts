/**
 * In-memory map: inventory-item GID → its product + variant GIDs.
 *
 * `inventory_items/update` tells us a cost changed but not which product it
 * belongs to. Every `products/update` payload lists each variant's
 * `inventory_item_id`, so we populate this map from product webhooks (free, no
 * fetch) and look it up when an inventory webhook arrives. Process-local: it
 * resets on redeploy and refills from product traffic; a cold miss falls back to
 * a single GraphQL lookup (see webhook-queue.server.ts).
 */
const map = new Map<string, { productId: string; variantId: string }>();

/**
 * Cap on retained entries. Every store's product webhooks feed this one
 * process-wide map and nothing ever removed from it, so on an Always On
 * instance that runs for weeks it grew for the whole uptime, across every
 * merchant. A miss is cheap — it costs one GraphQL lookup — so bounding it is
 * strictly better than letting it grow. Map preserves insertion order, so
 * deleting the first key evicts the oldest entry (re-inserting on access
 * below keeps the eviction order roughly least-recently-used).
 */
const MAX_ENTRIES = 50_000;

export function rememberInventoryItem(
  inventoryItemGid: string,
  productId: string,
  variantId: string,
): void {
  // Re-insert so refreshed entries move to the newest position.
  map.delete(inventoryItemGid);
  map.set(inventoryItemGid, { productId, variantId });

  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function lookupInventoryItem(
  inventoryItemGid: string,
): { productId: string; variantId: string } | null {
  return map.get(inventoryItemGid) ?? null;
}

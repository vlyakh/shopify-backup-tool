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

export function rememberInventoryItem(
  inventoryItemGid: string,
  productId: string,
  variantId: string,
): void {
  map.set(inventoryItemGid, { productId, variantId });
}

export function lookupInventoryItem(
  inventoryItemGid: string,
): { productId: string; variantId: string } | null {
  return map.get(inventoryItemGid) ?? null;
}

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../services/webhook-queue.server";

/**
 * Inventory item updated — carries `cost` (and HS code / origin). The payload is
 * the inventory item, not a product, so we enqueue it keyed by the inventory-item
 * GID and let the processor attribute it to a product (see webhook-queue).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  console.log(`[Webhook] inventory_items/update for ${shop}`);

  // Enqueue under the literal marker the processor switches on. Do NOT use the
  // `topic` from authenticate.webhook — the library normalizes it to upper-snake
  // ("INVENTORY_ITEMS_UPDATE"), which would never match the processor's
  // "inventory_items/update" check, so the cost handler would never run.
  await enqueueWebhook(
    shop,
    "inventory_items/update",
    "PRODUCT", // placeholder; the processor resolves the real product
    String(payload.admin_graphql_api_id),
    "UPDATED",
    payload,
    webhookId,
  );

  return new Response(null, { status: 200 });
};

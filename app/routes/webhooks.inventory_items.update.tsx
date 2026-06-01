import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../services/webhook-queue.server";

/**
 * Inventory item updated — carries `cost` (and HS code / origin). The payload is
 * the inventory item, not a product, so we enqueue it keyed by the inventory-item
 * GID and let the processor attribute it to a product (see webhook-queue).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  await enqueueWebhook(
    shop,
    topic,
    "PRODUCT", // placeholder; the processor resolves the real product
    String(payload.admin_graphql_api_id),
    "UPDATED",
    payload,
  );

  return new Response(null, { status: 200 });
};

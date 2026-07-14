import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../services/webhook-queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Delete payloads only carry the numeric id — build the GID so the ledger
  // keys line up with the create/update events for the same collection.
  const resourceId = payload.admin_graphql_api_id
    ? String(payload.admin_graphql_api_id)
    : payload.id != null
      ? `gid://shopify/Collection/${payload.id}`
      : null;
  if (!resourceId) {
    console.error(`[Webhook] ${topic} for ${shop}: payload has no id, skipping`);
    return new Response(null, { status: 200 });
  }

  await enqueueWebhook(shop, topic, "COLLECTION", resourceId, "DELETED", payload, webhookId);

  return new Response(null, { status: 200 });
};

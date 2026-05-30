import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../services/webhook-queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  await enqueueWebhook(shop, topic, "PRODUCT", String(payload.admin_graphql_api_id), "CREATED", payload);

  return new Response(null, { status: 200 });
};

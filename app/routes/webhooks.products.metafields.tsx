import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enqueueWebhook } from "../services/webhook-queue.server";

/**
 * A second products/update subscription, registered programmatically with
 * includeFields=["admin_graphql_api_id","metafields"] + metafieldNamespaces, so
 * its payload carries the product's metafields (the normal product webhook
 * doesn't). Enqueued under a "products/metafields" marker topic so the processor
 * routes it to the metafield diff.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  console.log(`[Webhook] products/metafields for ${shop}`);

  await enqueueWebhook(
    shop,
    "products/metafields",
    "PRODUCT",
    String(payload.admin_graphql_api_id),
    "UPDATED",
    payload,
  );

  return new Response(null, { status: 200 });
};

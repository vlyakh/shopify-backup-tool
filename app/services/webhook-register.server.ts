/**
 * Register the metafields-scoped products/update webhook programmatically.
 *
 * Declarative (TOML) webhooks can't set `metafieldNamespaces`, and the normal
 * product webhook doesn't carry metafields. So we add a SECOND products/update
 * subscription with includeFields=["admin_graphql_api_id","metafields"] +
 * metafieldNamespaces, delivering the product's metafields to
 * /webhooks/products/metafields. Idempotent — skips if it already exists.
 */
type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// Namespaces whose metafields we capture. "custom" = admin-created default,
// "global" = SEO (title_tag / description_tag). Extend as needed.
const NAMESPACES = ["custom", "global"];

export async function ensureMetafieldWebhook(
  admin: AdminGraphql,
  appUrl: string,
): Promise<void> {
  if (!appUrl) return;
  const callbackUrl = `${appUrl}/webhooks/products/metafields`;
  try {
    const existingResp = await admin.graphql(`#graphql
      query {
        webhookSubscriptions(first: 100) {
          nodes {
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
        }
      }`);
    const existing = (await existingResp.json()) as {
      data?: {
        webhookSubscriptions?: {
          nodes?: Array<{ endpoint?: { callbackUrl?: string } }>;
        };
      };
    };
    const nodes = existing.data?.webhookSubscriptions?.nodes ?? [];
    if (nodes.some((n) => n.endpoint?.callbackUrl === callbackUrl)) return;

    const createResp = await admin.graphql(
      `#graphql
      mutation register($sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(
          topic: PRODUCTS_UPDATE
          webhookSubscription: $sub
        ) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          sub: {
            callbackUrl,
            format: "JSON",
            includeFields: ["admin_graphql_api_id", "metafields"],
            metafieldNamespaces: NAMESPACES,
          },
        },
      },
    );
    const created = (await createResp.json()) as {
      data?: {
        webhookSubscriptionCreate?: {
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    const errs = created.data?.webhookSubscriptionCreate?.userErrors ?? [];
    if (errs.length) {
      console.error("[WebhookRegister] metafields subscription errors:", errs);
    } else {
      console.log(`[WebhookRegister] metafields subscription created: ${callbackUrl}`);
    }
  } catch (error) {
    console.error("[WebhookRegister] metafields subscription failed:", error);
  }
}

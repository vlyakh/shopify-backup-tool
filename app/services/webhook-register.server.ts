/**
 * Register webhook subscriptions that declarative shopify.app.toml can't fully
 * express, or that we don't want to depend on `shopify app deploy` to activate.
 * Run from afterAuth — idempotent (skips any subscription whose callbackUrl
 * already exists) and fire-and-forget.
 *
 *  - products/metafields: a SECOND products/update subscription scoped to
 *    metafieldNamespaces. Declarative TOML can't set metafieldNamespaces, and
 *    the normal product webhook doesn't carry metafields.
 *  - inventory_items/update: carries cost / HS code / country of origin, none
 *    of which are in the product payload. This topic IS also declared in the
 *    TOML, but the TOML only takes effect after `shopify app deploy`;
 *    registering it here means a plain install/auth activates cost tracking
 *    with no separate CLI deploy. (The store still needs read_inventory granted
 *    for `cost` to appear in the payload — that comes from the access scopes.)
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

const CREATE_SUBSCRIPTION = `#graphql
  mutation register(
    $topic: WebhookSubscriptionTopic!
    $sub: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      userErrors {
        field
        message
      }
    }
  }`;

export async function ensureWebhooks(
  admin: AdminGraphql,
  appUrl: string,
): Promise<void> {
  if (!appUrl) return;

  const metafieldUrl = `${appUrl}/webhooks/products/metafields`;
  const inventoryUrl = `${appUrl}/webhooks/inventory_items/update`;

  try {
    const existingResp = await admin.graphql(`#graphql
      query {
        webhookSubscriptions(first: 100) {
          nodes {
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
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
    // Match on PATH, not the full URL: the inventory topic is ALSO declared in
    // shopify.app.toml, whose callbackUrl is built from application_url; if
    // SHOPIFY_APP_URL differs (trailing slash, tunnel host, scheme), a full-URL
    // compare would miss it and create a duplicate subscription.
    const paths = new Set<string>();
    for (const n of existing.data?.webhookSubscriptions?.nodes ?? []) {
      const u = n.endpoint?.callbackUrl;
      if (!u) continue;
      try {
        paths.add(new URL(u).pathname);
      } catch {
        paths.add(u);
      }
    }

    const create = async (
      label: string,
      topic: string,
      sub: Record<string, unknown>,
    ) => {
      const resp = await admin.graphql(CREATE_SUBSCRIPTION, {
        variables: { topic, sub },
      });
      const json = (await resp.json()) as {
        data?: {
          webhookSubscriptionCreate?: {
            userErrors?: Array<{ message: string }>;
          };
        };
      };
      const errs = json.data?.webhookSubscriptionCreate?.userErrors ?? [];
      if (errs.length) {
        console.error(`[WebhookRegister] ${label} subscription errors:`, errs);
      } else {
        console.log(`[WebhookRegister] ${label} subscription created: ${sub.callbackUrl}`);
      }
    };

    // Metafields-scoped products/update.
    if (!paths.has("/webhooks/products/metafields")) {
      await create("metafields", "PRODUCTS_UPDATE", {
        callbackUrl: metafieldUrl,
        format: "JSON",
        includeFields: ["admin_graphql_api_id", "metafields"],
        metafieldNamespaces: NAMESPACES,
      });
    }

    // inventory_items/update (cost / HS code / country of origin).
    if (!paths.has("/webhooks/inventory_items/update")) {
      await create("inventory_items", "INVENTORY_ITEMS_UPDATE", {
        callbackUrl: inventoryUrl,
        format: "JSON",
      });
    }
  } catch (error) {
    console.error("[WebhookRegister] subscription registration failed:", error);
  }
}

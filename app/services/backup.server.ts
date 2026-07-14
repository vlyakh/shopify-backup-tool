import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { storage } from "./storage.server";
import { createHash } from "crypto";
import type { ResourceType, BackupTrigger } from "@prisma/client";
import { NAMESPACES } from "./webhook-register.server";

const PRODUCTS_QUERY = `#graphql
  query GetProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        descriptionHtml
        productType
        vendor
        tags
        status
        templateSuffix
        publishedAt
        category {
          id
          name
        }
        options {
          id
          name
          position
          values
        }
        variants(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            taxable
            position
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
              tracked
              requiresShipping
              unitCost {
                amount
              }
              harmonizedSystemCode
              countryCodeOfOrigin
              measurement {
                weight {
                  value
                  unit
                }
              }
            }
          }
        }
        images(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            url
            altText
            width
            height
          }
        }
        metafields(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            namespace
            key
            value
            type
          }
        }
        seo {
          title
          description
        }
      }
    }
  }
`;

const COLLECTIONS_QUERY = `#graphql
  query GetCollections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        descriptionHtml
        sortOrder
        templateSuffix
        image {
          url
          altText
        }
        seo {
          title
          description
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
        metafields(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            namespace
            key
            value
            type
          }
        }
      }
    }
  }
`;

const PAGES_QUERY = `#graphql
  query GetPages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        body
        bodySummary
        isPublished
        templateSuffix
        metafields(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            namespace
            key
            value
            type
          }
        }
      }
    }
  }
`;

const BLOG_ARTICLES_QUERY = `#graphql
  query GetArticles($cursor: String) {
    articles(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        contentHtml
        summary
        tags
        blog {
          id
          title
        }
        image {
          url
          altText
        }
        seo {
          title
          description
        }
        isPublished
      }
    }
  }
`;

const REDIRECTS_QUERY = `#graphql
  query GetRedirects($cursor: String) {
    urlRedirects(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        path
        target
      }
    }
  }
`;

const MENUS_QUERY = `#graphql
  query GetMenus($cursor: String) {
    menus(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        items {
          id
          title
          type
          url
          items {
            id
            title
            type
            url
          }
        }
      }
    }
  }
`;

// Per-resource follow-up queries for nested connections that overflow the
// first page of the bulk queries above (big products/collections/pages).
// Field sets must mirror the bulk queries so merged nodes stay homogeneous.
const PRODUCT_VARIANTS_PAGE_QUERY = `#graphql
  query GetProductVariantsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          taxable
          position
          selectedOptions {
            name
            value
          }
          inventoryItem {
            id
            tracked
            requiresShipping
            unitCost {
              amount
            }
            harmonizedSystemCode
            countryCodeOfOrigin
            measurement {
              weight {
                value
                unit
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_IMAGES_PAGE_QUERY = `#graphql
  query GetProductImagesPage($id: ID!, $cursor: String) {
    product(id: $id) {
      images(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          url
          altText
          width
          height
        }
      }
    }
  }
`;

const PRODUCT_METAFIELDS_PAGE_QUERY = `#graphql
  query GetProductMetafieldsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      metafields(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
    }
  }
`;

const COLLECTION_METAFIELDS_PAGE_QUERY = `#graphql
  query GetCollectionMetafieldsPage($id: ID!, $cursor: String) {
    collection(id: $id) {
      metafields(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
    }
  }
`;

const PAGE_METAFIELDS_PAGE_QUERY = `#graphql
  query GetPageMetafieldsPage($id: ID!, $cursor: String) {
    page(id: $id) {
      metafields(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
    }
  }
`;

function hashData(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const THROTTLE_MAX_ATTEMPTS = 5;

function isThrottledError(error: unknown): boolean {
  if (error instanceof Response) return error.status === 429;
  const e = error as {
    message?: unknown;
    status?: unknown;
    response?: { status?: number; code?: number } | null;
    body?: { errors?: Array<{ extensions?: { code?: string } } | null> } | null;
  };
  if (e?.status === 429 || e?.response?.status === 429 || e?.response?.code === 429) {
    return true;
  }
  const errors = e?.body?.errors;
  if (Array.isArray(errors) && errors.some((err) => err?.extensions?.code === "THROTTLED")) {
    return true;
  }
  return typeof e?.message === "string" && e.message.toLowerCase().includes("throttled");
}

/**
 * admin.graphql with exponential backoff (1s/2s/4s/8s) on THROTTLED/429 so a
 * rate-limit blip doesn't fail the whole backup. The library THROWS on
 * top-level GraphQL errors (throttling included), so detection covers the
 * thrown case as well as a plain 429 response.
 *
 * Exported so other multi-query call sites (e.g. the backup-detail loader's
 * live-existence checks) share the same throttle handling.
 */
export async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  options?: Parameters<AdminApiContext["graphql"]>[1],
): Promise<Awaited<ReturnType<AdminApiContext["graphql"]>>> {
  let delayMs = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await admin.graphql(query, options);
      if (response.status === 429 && attempt < THROTTLE_MAX_ATTEMPTS) {
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= THROTTLE_MAX_ATTEMPTS || !isThrottledError(error)) throw error;
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

async function paginatedFetch(
  admin: AdminApiContext,
  query: string,
  rootField: string,
  onPage?: () => Promise<void>,
): Promise<unknown[]> {
  const allNodes: unknown[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  type GraphQLPage = {
    data?: Record<
      string,
      | {
          nodes: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        }
      | undefined
    >;
  };

  while (hasNextPage) {
    const response = await graphqlWithRetry(admin, query, {
      variables: { cursor },
    });
    if (onPage) await onPage();
    const json = (await response.json()) as GraphQLPage;
    const data = json.data?.[rootField];

    if (!data) break;

    allNodes.push(...data.nodes);
    hasNextPage = data.pageInfo?.hasNextPage ?? false;
    cursor = data.pageInfo?.endCursor ?? null;
  }

  return allNodes;
}

type NestedConnection = {
  nodes?: unknown[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

interface NestedPaginationSpec {
  /** Field on the node holding the capped connection, e.g. "variants" */
  connectionField: string;
  /** Singular root field of the follow-up query, e.g. "product" */
  rootField: string;
  query: string;
}

// Nested connections the bulk queries cap; anything past the first page is
// fetched per-resource and merged before the node is hashed/stored.
const NESTED_PAGINATION: Partial<Record<ResourceType, NestedPaginationSpec[]>> = {
  PRODUCT: [
    { connectionField: "variants", rootField: "product", query: PRODUCT_VARIANTS_PAGE_QUERY },
    { connectionField: "images", rootField: "product", query: PRODUCT_IMAGES_PAGE_QUERY },
    { connectionField: "metafields", rootField: "product", query: PRODUCT_METAFIELDS_PAGE_QUERY },
  ],
  COLLECTION: [
    { connectionField: "metafields", rootField: "collection", query: COLLECTION_METAFIELDS_PAGE_QUERY },
  ],
  PAGE: [
    { connectionField: "metafields", rootField: "page", query: PAGE_METAFIELDS_PAGE_QUERY },
  ],
};

/**
 * Fetches the remaining pages of a node's nested connection (variants/images/
 * metafields) when the bulk query's first page was truncated, and merges them
 * into the node. Strips pageInfo afterwards so stored blobs keep the same
 * { nodes: [...] } shape as before.
 */
async function completeNestedConnection(
  admin: AdminApiContext,
  node: Record<string, unknown>,
  spec: NestedPaginationSpec,
  onPage?: () => Promise<void>,
): Promise<void> {
  const conn = node[spec.connectionField] as NestedConnection | undefined;
  if (!conn) return;

  let hasNextPage = conn.pageInfo?.hasNextPage ?? false;
  let cursor = conn.pageInfo?.endCursor ?? null;
  const nodes = [...(conn.nodes ?? [])];

  while (hasNextPage && cursor) {
    const response = await graphqlWithRetry(admin, spec.query, {
      variables: { id: node.id, cursor },
    });
    if (onPage) await onPage();
    const json = (await response.json()) as {
      data?: Record<
        string,
        Record<string, NestedConnection | undefined> | null | undefined
      >;
    };
    const page = json.data?.[spec.rootField]?.[spec.connectionField];
    if (!page) break;

    nodes.push(...(page.nodes ?? []));
    hasNextPage = page.pageInfo?.hasNextPage ?? false;
    cursor = page.pageInfo?.endCursor ?? null;
  }

  conn.nodes = nodes;
  delete conn.pageInfo;
}

/**
 * Completes ALL of a live product node's capped nested connections (variants/
 * images/metafields) by following their remaining pages and merging the nodes
 * in, stripping pageInfo afterwards. The caller's query must select pageInfo
 * on those connections (otherwise this is a no-op on the first page only).
 *
 * Exported for api.product-diff, whose live product must carry the SAME
 * complete node set as the blobs runBackup stores — otherwise any product
 * with >100 variants / >50 images / >50 metafields compares "changed" forever
 * because the live side is truncated while the backup side is complete.
 */
export async function completeProductNestedConnections(
  admin: AdminApiContext,
  productNode: Record<string, unknown>,
): Promise<void> {
  for (const spec of NESTED_PAGINATION.PRODUCT ?? []) {
    await completeNestedConnection(admin, productNode, spec);
  }
}

interface BackupResourceResult {
  count: number;
  sizeBytes: number;
  items: Array<{
    resourceType: ResourceType;
    resourceId: string;
    title: string;
    dataHash: string;
    storagePath: string;
  }>;
}

async function backupResource(
  admin: AdminApiContext,
  storeId: string,
  backupId: string,
  query: string,
  rootField: string,
  resourceType: ResourceType,
  onProgress?: () => Promise<void>,
  onNode?: (node: unknown) => Promise<void>,
  onPage?: () => Promise<void>,
): Promise<BackupResourceResult> {
  const nodes = await paginatedFetch(admin, query, rootField, onPage);
  const items: BackupResourceResult["items"] = [];
  let sizeBytes = 0;

  for (const node of nodes) {
    // Merge any nested pages the bulk query truncated before hashing/storing
    for (const spec of NESTED_PAGINATION[resourceType] ?? []) {
      await completeNestedConnection(admin, node as Record<string, unknown>, spec, onPage);
    }

    const typedNode = node as { id: string; title?: string; path?: string; handle?: string };
    const resourceId = typedNode.id;
    const title = typedNode.title || typedNode.path || typedNode.handle || resourceId;
    const dataHash = hashData(node);
    const storagePath = `${storeId}/${backupId}/${resourceType}/${encodeURIComponent(resourceId)}.json`;

    const json = JSON.stringify(node, null, 2);
    await storage.put(storagePath, json);
    sizeBytes += Buffer.byteLength(json, "utf-8");
    if (onNode) await onNode(node);

    items.push({ resourceType, resourceId, title, dataHash, storagePath });
    if (onProgress) await onProgress();
  }

  return { count: nodes.length, sizeBytes, items };
}

/**
 * Canonical cost string so a backup seed and a webhook payload compare equal
 * regardless of trailing-zero formatting ("550.0" vs "550.00" → "550").
 */
function normCost(x: unknown): string | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? String(n) : String(x);
}

/**
 * Seed per-variant inventory state (cost / HS code / origin) from a backed-up
 * product, so the FIRST post-backup cost edit diffs against the real prior value
 * instead of "—". Mirrors the {store}/state/inventory/{variantId}.json shape that
 * handleInventoryItemUpdate reads/writes (REST snake_case keys, string | null).
 */
// GraphQL WeightUnit enum -> the unit string the inventory_items/update webhook
// uses, so a seeded weight_unit compares equal to the webhook's.
const WEIGHT_UNIT_TO_REST: Record<string, string> = {
  GRAMS: "g",
  KILOGRAMS: "kg",
  OUNCES: "oz",
  POUNDS: "lb",
};

async function seedInventoryState(
  storeId: string,
  productNode: unknown,
): Promise<void> {
  const variants = ((productNode as { variants?: { nodes?: unknown[] } })
    ?.variants?.nodes ?? []) as Array<{
    id?: string;
    inventoryItem?: {
      unitCost?: { amount?: unknown } | null;
      harmonizedSystemCode?: unknown;
      countryCodeOfOrigin?: unknown;
      measurement?: { weight?: { value?: unknown; unit?: unknown } | null } | null;
    } | null;
  }>;
  for (const v of variants) {
    if (!v?.id) continue;
    const statePath = `${storeId}/state/inventory/${encodeURIComponent(v.id)}.json`;
    // Write-if-absent: webhook-built state is fresher than the snapshot, so an
    // existing blob must not be overwritten mid-backup (phantom change rows).
    if ((await storage.get(statePath)) != null) continue;
    const inv = v.inventoryItem ?? {};
    const w = inv.measurement?.weight;
    const state = {
      cost: normCost(inv.unitCost?.amount),
      harmonized_system_code:
        inv.harmonizedSystemCode != null ? String(inv.harmonizedSystemCode) : null,
      country_code_of_origin:
        inv.countryCodeOfOrigin != null ? String(inv.countryCodeOfOrigin) : null,
      weight_value: w?.value != null ? normCost(w.value) : null,
      weight_unit:
        w?.unit != null
          ? WEIGHT_UNIT_TO_REST[String(w.unit)] ?? String(w.unit).toLowerCase()
          : null,
    };
    await storage.put(statePath, JSON.stringify(state));
  }
}

/**
 * Seed per-product metafield state (tracked namespaces only) from a backed-up
 * product, so the FIRST post-backup products/metafields webhook diffs against
 * the real values instead of an empty baseline — otherwise every existing
 * metafield (incl. the SEO title_tag/description_tag) shows as "Added".
 * Mirrors the {store}/state/metafields/{productId}.json shape handleProduct
 * Metafields reads/writes: { "namespace|key": {namespace, key, value, type} }.
 */
async function seedMetafieldState(
  storeId: string,
  productNode: unknown,
): Promise<void> {
  const productId = (productNode as { id?: string })?.id;
  if (!productId) return;
  const statePath = `${storeId}/state/metafields/${encodeURIComponent(productId)}.json`;
  // Write-if-absent: webhook-built state is fresher than the snapshot, so an
  // existing blob must not be overwritten mid-backup (phantom change rows).
  if ((await storage.get(statePath)) != null) return;
  const tracked = new Set(NAMESPACES);
  const nodes = ((productNode as { metafields?: { nodes?: unknown[] } })
    ?.metafields?.nodes ?? []) as Array<{
    namespace?: string;
    key?: string;
    value?: unknown;
    type?: unknown;
  }>;
  const state: Record<
    string,
    { namespace: string; key: string; value: string | null; type?: string }
  > = {};
  for (const mf of nodes) {
    const ns = String(mf.namespace ?? "");
    const key = String(mf.key ?? "");
    if (!ns || !key || !tracked.has(ns)) continue;
    state[`${ns}|${key}`] = {
      namespace: ns,
      key,
      value: mf.value != null ? String(mf.value) : null,
      ...(mf.type != null ? { type: String(mf.type) } : {}),
    };
  }
  await storage.put(statePath, JSON.stringify(state));
}

/**
 * Best-effort removal of every blob a backup wrote ({store}/{backupId}/...).
 * Returns false when deletion failed so callers that must not orphan blobs
 * (retention) can keep the DB row and retry later.
 */
export async function deleteBackupBlobs(
  storeId: string,
  backupId: string,
): Promise<boolean> {
  try {
    await storage.deletePrefix(`${storeId}/${backupId}/`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Backup ${backupId}] Failed to delete blobs: ${message}`);
    return false;
  }
}

export async function runBackup(
  admin: AdminApiContext,
  storeId: string,
  trigger: BackupTrigger,
  plan: string,
  existingBackupId?: string,
): Promise<string> {
  // Create the backup record (or claim one pre-created by startBackupIfIdle)
  const backup = existingBackupId
    ? await prisma.backup.update({
        where: { id: existingBackupId },
        data: { status: "IN_PROGRESS" },
      })
    : await prisma.backup.create({
        data: {
          storeId,
          trigger,
          status: "IN_PROGRESS",
        },
      });

  // Heartbeat — touches Backup.updatedAt (at most once a minute) so the
  // stalled-backup sweep in scheduler.server.ts never mistakes a live run for
  // a crashed one. The fetch phases would otherwise leave the row untouched
  // past the sweep's 30-minute cutoff on large stores: paginatedFetch walks
  // EVERY page of a resource (with up to ~15s of throttle backoff per page)
  // before the first item is stored, and only stored items bump the row.
  let lastHeartbeatMs = Date.now();
  const heartbeat = async () => {
    if (Date.now() - lastHeartbeatMs < 60 * 1000) return;
    lastHeartbeatMs = Date.now();
    try {
      await prisma.backup.update({
        where: { id: backup.id },
        data: { updatedAt: new Date() },
      });
    } catch (error) {
      // Best-effort: a heartbeat blip must never fail the backup itself
      console.error(`[Backup ${backup.id}] Heartbeat failed:`, error);
    }
  };

  // Throttled progress updater — bumps Backup.processedCount as items are
  // saved so the dashboard can show a live count while IN_PROGRESS.
  let processed = 0;
  const onProgress = async () => {
    processed++;
    if (processed % 10 === 0) {
      await prisma.backup.update({
        where: { id: backup.id },
        data: { processedCount: processed },
      });
      lastHeartbeatMs = Date.now(); // that write already bumped updatedAt
    } else {
      await heartbeat();
    }
  };

  try {
    const allItems: BackupResourceResult["items"] = [];
    let totalSize = 0;
    let variantCount = 0;

    // Products - all plans
    console.log(`[Backup ${backup.id}] Backing up products...`);
    const products = await backupResource(
      admin, storeId, backup.id, PRODUCTS_QUERY, "products", "PRODUCT", onProgress,
      async (node) => {
        variantCount +=
          (node as { variants?: { nodes?: unknown[] } }).variants?.nodes?.length ?? 0;
        // Best-effort: a seeding hiccup must never fail an otherwise-good backup.
        try {
          await Promise.all([
            seedInventoryState(storeId, node),
            seedMetafieldState(storeId, node),
          ]);
        } catch (e) {
          console.error(`[Backup ${backup.id}] state seed failed:`, e);
        }
      },
      heartbeat,
    );
    allItems.push(...products.items);
    totalSize += products.sizeBytes;

    // Collections, pages, etc. - STANDARD and PREMIUM only
    let collectionCount = 0;
    let pageCount = 0;
    let blogPostCount = 0;
    let redirectCount = 0;

    if (plan !== "FREE") {
      console.log(`[Backup ${backup.id}] Backing up collections...`);
      const collections = await backupResource(
        admin, storeId, backup.id, COLLECTIONS_QUERY, "collections", "COLLECTION", onProgress,
        undefined, heartbeat,
      );
      allItems.push(...collections.items);
      totalSize += collections.sizeBytes;
      collectionCount = collections.count;

      console.log(`[Backup ${backup.id}] Backing up pages...`);
      const pages = await backupResource(
        admin, storeId, backup.id, PAGES_QUERY, "pages", "PAGE", onProgress,
        undefined, heartbeat,
      );
      allItems.push(...pages.items);
      totalSize += pages.sizeBytes;
      pageCount = pages.count;

      console.log(`[Backup ${backup.id}] Backing up blog articles...`);
      const articles = await backupResource(
        admin, storeId, backup.id, BLOG_ARTICLES_QUERY, "articles", "BLOG_POST", onProgress,
        undefined, heartbeat,
      );
      allItems.push(...articles.items);
      totalSize += articles.sizeBytes;
      blogPostCount = articles.count;

      console.log(`[Backup ${backup.id}] Backing up redirects...`);
      const redirects = await backupResource(
        admin, storeId, backup.id, REDIRECTS_QUERY, "urlRedirects", "REDIRECT", onProgress,
        undefined, heartbeat,
      );
      allItems.push(...redirects.items);
      totalSize += redirects.sizeBytes;
      redirectCount = redirects.count;

      console.log(`[Backup ${backup.id}] Backing up menus...`);
      const menus = await backupResource(
        admin, storeId, backup.id, MENUS_QUERY, "menus", "MENU", onProgress,
        undefined, heartbeat,
      );
      allItems.push(...menus.items);
      totalSize += menus.sizeBytes;
    }

    // Batch insert all backup items
    await prisma.backupItem.createMany({
      data: allItems.map((item) => ({
        backupId: backup.id,
        ...item,
      })),
    });

    // Update backup with final stats — guarded on status so only a still-live
    // row can complete. If the stalled-backup sweep raced this run, marked it
    // FAILED and deleted its blobs, flipping it back to COMPLETED would
    // advertise a healthy snapshot whose blobs are gone (and retention would
    // then protect it forever as the store's last good backup).
    const completed = await prisma.backup.updateMany({
      where: { id: backup.id, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        errorMessage: null,
        productCount: products.count,
        variantCount,
        collectionCount,
        pageCount,
        blogPostCount,
        redirectCount,
        processedCount: processed,
        sizeBytes: BigInt(totalSize),
      },
    });
    if (completed.count === 0) {
      // Swept mid-run: the earlier blobs are already deleted, so the item
      // rows just created point at nothing — remove them, then let the catch
      // below record the failure and clean up any post-sweep blobs.
      await prisma.backupItem.deleteMany({ where: { backupId: backup.id } });
      throw new Error(
        "Backup was marked stalled and cleaned up while still running; results discarded",
      );
    }

    console.log(`[Backup ${backup.id}] Completed: ${products.count} products, ${collectionCount} collections, ${pageCount} pages`);
    return backup.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.backup.update({
      where: { id: backup.id },
      data: {
        status: "FAILED",
        errorMessage: message,
      },
    });
    // Don't leak the partial blobs a failed run already wrote
    await deleteBackupBlobs(storeId, backup.id);
    console.error(`[Backup ${backup.id}] Failed:`, message);
    throw error;
  }
}

/**
 * Starts a backup for the store unless one is already PENDING/IN_PROGRESS.
 * Runs in the background (fire-and-forget) and returns the backupId
 * immediately so callers (dashboard action) can respond without waiting.
 */
export async function startBackupIfIdle(
  shop: string,
  trigger: BackupTrigger,
): Promise<{ started: true; backupId: string } | { started: false; reason: string }> {
  const store = await prisma.store.findUnique({ where: { id: shop } });
  if (!store) return { started: false, reason: "store-not-found" };

  const active = await prisma.backup.findFirst({
    where: { storeId: shop, status: { in: ["PENDING", "IN_PROGRESS"] } },
  });
  if (active) return { started: false, reason: "already-running" };

  // Same offline-session mechanism the scheduler uses to get an admin client.
  // Dynamic import mirrors shopify.server's lazy import of this module.
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(shop);

  const backup = await prisma.backup.create({
    data: { storeId: shop, trigger, status: "PENDING" },
  });

  runBackup(admin, shop, trigger, store.plan, backup.id).catch(async (error) => {
    // runBackup marks its own row FAILED; this covers anything before that.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Backup ${backup.id}] Background run failed:`, message);
    try {
      await prisma.backup.updateMany({
        where: { id: backup.id, status: { in: ["PENDING", "IN_PROGRESS"] } },
        data: { status: "FAILED", errorMessage: message },
      });
    } catch (updateError) {
      console.error(`[Backup ${backup.id}] Could not mark FAILED:`, updateError);
    }
  });

  return { started: true, backupId: backup.id };
}

export async function getBackupData(storagePath: string): Promise<unknown> {
  const data = await storage.get(storagePath);
  return data ? JSON.parse(data) : null;
}

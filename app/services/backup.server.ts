import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { storage } from "./storage.server";
import { createHash } from "crypto";
import type { ResourceType, BackupTrigger } from "@prisma/client";

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
          nodes {
            id
            url
            altText
            width
            height
          }
        }
        metafields(first: 50) {
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
  query GetMenus {
    menus(first: 50) {
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

function hashData(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

async function paginatedFetch(
  admin: AdminApiContext,
  query: string,
  rootField: string,
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
    const response = await admin.graphql(query, {
      variables: { cursor },
    });
    const json = (await response.json()) as GraphQLPage;
    const data = json.data?.[rootField];

    if (!data) break;

    allNodes.push(...data.nodes);
    hasNextPage = data.pageInfo?.hasNextPage ?? false;
    cursor = data.pageInfo?.endCursor ?? null;
  }

  return allNodes;
}

interface BackupResourceResult {
  count: number;
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
): Promise<BackupResourceResult> {
  const nodes = await paginatedFetch(admin, query, rootField);
  const items: BackupResourceResult["items"] = [];

  for (const node of nodes) {
    const typedNode = node as { id: string; title?: string; path?: string; handle?: string };
    const resourceId = typedNode.id;
    const title = typedNode.title || typedNode.path || typedNode.handle || resourceId;
    const dataHash = hashData(node);
    const storagePath = `${storeId}/${backupId}/${resourceType}/${encodeURIComponent(resourceId)}.json`;

    await storage.put(storagePath, JSON.stringify(node, null, 2));

    items.push({ resourceType, resourceId, title, dataHash, storagePath });
  }

  return { count: nodes.length, items };
}

export async function runBackup(
  admin: AdminApiContext,
  storeId: string,
  trigger: BackupTrigger,
  plan: string,
): Promise<string> {
  // Create the backup record
  const backup = await prisma.backup.create({
    data: {
      storeId,
      trigger,
      status: "IN_PROGRESS",
    },
  });

  try {
    const allItems: BackupResourceResult["items"] = [];
    let totalSize = 0;

    // Products - all plans
    console.log(`[Backup ${backup.id}] Backing up products...`);
    const products = await backupResource(
      admin, storeId, backup.id, PRODUCTS_QUERY, "products", "PRODUCT",
    );
    allItems.push(...products.items);

    // Collections, pages, etc. - STANDARD and PREMIUM only
    let collectionCount = 0;
    let pageCount = 0;
    let blogPostCount = 0;
    let redirectCount = 0;

    if (plan !== "FREE") {
      console.log(`[Backup ${backup.id}] Backing up collections...`);
      const collections = await backupResource(
        admin, storeId, backup.id, COLLECTIONS_QUERY, "collections", "COLLECTION",
      );
      allItems.push(...collections.items);
      collectionCount = collections.count;

      console.log(`[Backup ${backup.id}] Backing up pages...`);
      const pages = await backupResource(
        admin, storeId, backup.id, PAGES_QUERY, "pages", "PAGE",
      );
      allItems.push(...pages.items);
      pageCount = pages.count;

      console.log(`[Backup ${backup.id}] Backing up blog articles...`);
      const articles = await backupResource(
        admin, storeId, backup.id, BLOG_ARTICLES_QUERY, "articles", "BLOG_POST",
      );
      allItems.push(...articles.items);
      blogPostCount = articles.count;

      console.log(`[Backup ${backup.id}] Backing up redirects...`);
      const redirects = await backupResource(
        admin, storeId, backup.id, REDIRECTS_QUERY, "urlRedirects", "REDIRECT",
      );
      allItems.push(...redirects.items);
      redirectCount = redirects.count;

      console.log(`[Backup ${backup.id}] Backing up menus...`);
      const menus = await backupResource(
        admin, storeId, backup.id, MENUS_QUERY, "menus", "MENU",
      );
      allItems.push(...menus.items);
    }

    // Count variants
    const variantCount = products.items.length; // Each product node includes variants

    // Batch insert all backup items
    await prisma.backupItem.createMany({
      data: allItems.map((item) => ({
        backupId: backup.id,
        ...item,
      })),
    });

    // Update backup with final stats
    await prisma.backup.update({
      where: { id: backup.id },
      data: {
        status: "COMPLETED",
        productCount: products.count,
        variantCount,
        collectionCount,
        pageCount,
        blogPostCount,
        redirectCount,
        sizeBytes: BigInt(totalSize),
      },
    });

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
    console.error(`[Backup ${backup.id}] Failed:`, message);
    throw error;
  }
}

export async function getBackupData(storagePath: string): Promise<unknown> {
  const data = await storage.get(storagePath);
  return data ? JSON.parse(data) : null;
}

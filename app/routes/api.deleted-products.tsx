import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

/**
 * API endpoint for the Recover Deleted Products extension.
 * Returns products that were backed up but have since been deleted.
 *
 * Strategy: Find products in our change log with action=DELETED,
 * then match them to their most recent backup item for recovery.
 * If that matches nothing (no tracking, or only unmatched ledger rows),
 * fall back to comparing the latest backup against live Shopify.
 *
 * GET /api/deleted-products
 */

// Variant count for the recover list, read from the backed-up product blob
// (GraphQL shape: variants.nodes; tolerate a plain array). 0 when unreadable.
async function countVariants(storagePath: string): Promise<number> {
  try {
    const raw = await storage.get(storagePath);
    if (!raw) return 0;
    const v = (JSON.parse(raw) as { variants?: unknown }).variants;
    if (Array.isArray(v)) return v.length;
    const nodes = (v as { nodes?: unknown[] } | null)?.nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
  } catch {
    return 0;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);

  // Get recently deleted products from change log (last 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const deletedChanges = await prisma.changeLog.findMany({
    where: {
      storeId: session.shop,
      resourceType: "PRODUCT",
      action: "DELETED",
      // Rows written before the delete webhook built a GID hold the literal
      // string "undefined" — they can never match a backup item, and they
      // must not block the live-check fallback below either.
      resourceId: { not: "undefined" },
      changedAt: { gte: ninetyDaysAgo },
    },
    orderBy: { changedAt: "desc" },
    take: 50,
  });

  // Deduplicate by resourceId — a redelivered delete webhook records a second
  // row for the same product. Newest-first keeps the latest deletion time.
  const seen = new Set<string>();
  const uniqueDeletes = deletedChanges.filter((change) => {
    if (seen.has(change.resourceId)) return false;
    seen.add(change.resourceId);
    return true;
  });

  // Primary path: match ledger deletes to their most recent backup item.
  const products = [];
  for (const change of uniqueDeletes) {
    const backupItem = await prisma.backupItem.findFirst({
      where: {
        resourceId: change.resourceId,
        resourceType: "PRODUCT",
        backup: { storeId: session.shop, status: "COMPLETED" },
      },
      orderBy: { backup: { createdAt: "desc" } },
    });

    if (backupItem) {
      products.push({
        backupItemId: backupItem.id,
        title: backupItem.title || "Unknown Product",
        deletedAt: change.changedAt.toISOString(),
        variantCount: await countVariants(backupItem.storagePath),
      });
    }
  }

  if (products.length > 0) {
    return cors(json({ products }));
  }

  // Fallback whenever the ledger matched nothing: check if any backed-up
  // products no longer exist in Shopify. This covers stores without change
  // tracking (free/standard) AND stores whose ledger rows found no backup.
  // We check the most recent backup's products against Shopify.
  const latestBackup = await prisma.backup.findFirst({
    where: { storeId: session.shop, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        where: { resourceType: "PRODUCT" },
        take: 200,
      },
    },
  });

  if (!latestBackup?.items.length) {
    return cors(json({ products: [] }));
  }

  // Check which products still exist in Shopify
  const productGids = latestBackup.items.map((item) => item.resourceId);
  const batchSize = 50;
  const missingProducts = [];

  for (let i = 0; i < productGids.length; i += batchSize) {
    const batch = productGids.slice(i, i + batchSize);

    const response = await admin.graphql(
      `#graphql
        query CheckProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
            }
          }
        }
      `,
      { variables: { ids: batch } },
    );
    const result = await response.json();
    const existingIds = new Set(
      (result.data?.nodes || [])
        .filter((n: { id?: string } | null) => n?.id)
        .map((n: { id: string }) => n.id),
    );

    for (const gid of batch) {
      if (!existingIds.has(gid)) {
        const item = latestBackup.items.find((it) => it.resourceId === gid);
        if (item) {
          missingProducts.push({
            backupItemId: item.id,
            title: item.title || "Unknown Product",
            deletedAt: latestBackup.createdAt.toISOString(),
            variantCount: await countVariants(item.storagePath),
          });
        }
      }
    }
  }

  return cors(json({ products: missingProducts }));
};

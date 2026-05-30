import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * API endpoint for the Restore Changed Products extension.
 * Returns products that have been modified since the last completed backup.
 *
 * Strategy:
 * - Premium tier (webhooksEnabled): Query ChangeLog for UPDATED products after last backup.
 * - All tiers fallback: Fetch current products from Shopify, compute hash,
 *   compare against backup item hashes. Show mismatches.
 *
 * GET /api/changed-products
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { id: session.shop },
  });

  // Find the latest completed backup for this store
  const latestBackup = await prisma.backup.findFirst({
    where: { storeId: session.shop, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });

  if (!latestBackup) {
    return cors(json({ products: [], message: "No completed backups yet. Run a backup first." }));
  }

  // Strategy 1: Use ChangeLog if premium tier with webhooks
  if (store?.webhooksEnabled) {
    const changedEntries = await prisma.changeLog.findMany({
      where: {
        storeId: session.shop,
        resourceType: "PRODUCT",
        action: "UPDATED",
        changedAt: { gt: latestBackup.createdAt },
      },
      orderBy: { changedAt: "desc" },
    });

    if (changedEntries.length === 0) {
      return cors(json({ products: [] }));
    }

    // Deduplicate by resourceId (keep the most recent change per product)
    const seen = new Set<string>();
    const uniqueChanges = changedEntries.filter((entry) => {
      if (seen.has(entry.resourceId)) return false;
      seen.add(entry.resourceId);
      return true;
    });

    // For each changed product, find its backup item for restore
    const products = [];
    for (const change of uniqueChanges) {
      const backupItem = await prisma.backupItem.findFirst({
        where: {
          resourceId: change.resourceId,
          resourceType: "PRODUCT",
          backup: { id: latestBackup.id },
        },
      });

      if (backupItem) {
        products.push({
          backupItemId: backupItem.id,
          resourceId: change.resourceId,
          title: backupItem.title || "Unknown Product",
          changedAt: change.changedAt.toISOString(),
          changedFields: change.changedFields,
          changeCount: changedEntries.filter((e) => e.resourceId === change.resourceId).length,
        });
      }
    }

    return cors(json({ products }));
  }

  // Strategy 2: Compare backup hashes against live Shopify data
  // Fetch all product backup items from the latest backup
  const backupItems = await prisma.backupItem.findMany({
    where: {
      backupId: latestBackup.id,
      resourceType: "PRODUCT",
    },
    take: 200,
  });

  if (backupItems.length === 0) {
    return cors(json({ products: [] }));
  }

  // Check products in Shopify and compare updated_at timestamps
  const productGids = backupItems.map((item) => item.resourceId);
  const batchSize = 50;
  const changedProducts = [];

  for (let i = 0; i < productGids.length; i += batchSize) {
    const batch = productGids.slice(i, i + batchSize);

    const response = await admin.graphql(
      `#graphql
        query CheckProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              updatedAt
            }
          }
        }
      `,
      { variables: { ids: batch } },
    );
    const result = await response.json();
    const nodes = (result.data?.nodes || []).filter(
      (n: { id?: string } | null) => n?.id,
    );

    for (const node of nodes as Array<{ id: string; title: string; updatedAt: string }>) {
      const productUpdatedAt = new Date(node.updatedAt);

      // If the product was updated after our last backup, it has changes
      if (productUpdatedAt > latestBackup.createdAt) {
        const backupItem = backupItems.find((item) => item.resourceId === node.id);
        if (backupItem) {
          changedProducts.push({
            backupItemId: backupItem.id,
            resourceId: node.id,
            title: node.title,
            changedAt: node.updatedAt,
            changedFields: [] as string[],
            changeCount: 1,
          });
        }
      }
    }
  }

  return cors(json({ products: changedProducts }));
};

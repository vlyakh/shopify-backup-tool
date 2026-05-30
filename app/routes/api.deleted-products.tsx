import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * API endpoint for the Recover Deleted Products extension.
 * Returns products that were backed up but have since been deleted.
 *
 * Strategy: Find products in our change log with action=DELETED,
 * then match them to their most recent backup item for recovery.
 *
 * GET /api/deleted-products
 */
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
      changedAt: { gte: ninetyDaysAgo },
    },
    orderBy: { changedAt: "desc" },
    take: 50,
  });

  if (deletedChanges.length === 0) {
    // Fallback: check if any backed-up products no longer exist in Shopify.
    // This covers the case where change tracking isn't enabled (free/standard).
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
              variantCount: 0, // Unknown from backup item alone
            });
          }
        }
      }
    }

    return cors(json({ products: missingProducts }));
  }

  // We have change log entries for deleted products.
  // Find the corresponding backup items.
  const products = [];
  for (const change of deletedChanges) {
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
        variantCount: 0,
      });
    }
  }

  return cors(json({ products }));
};

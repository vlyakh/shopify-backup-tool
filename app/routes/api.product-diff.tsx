import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

/**
 * API endpoint for the product diff / undo UX (Undo block + Restore action).
 * Compares the live Shopify product against its latest COMPLETED backup and
 * reports whether it changed, plus a per-field summary of what changed.
 *
 * GET /api/product-diff?resourceId=gid://shopify/Product/123
 *
 * Response shape (consumed by the Undo block, the Restore action, and the dashboard):
 *   {
 *     hasBackup: boolean,        // a COMPLETED backup item with a readable blob exists
 *     changed: boolean,          // live product differs from backup on >= 1 DIFF_FIELDS key
 *     deleted?: boolean,         // present + true only when the live product no longer exists
 *     backupItemId: string|null, // BackupItem.id to POST to /api/revert-product
 *     lastBackedUp: string|null, // ISO timestamp of the backup's createdAt
 *     changedFields: Array<{ field: string; before: string; after: string }>
 *                                // before/after stringified + truncated to <= 80 chars (trailing "…")
 *   }
 */

// Field shape MUST mirror PRODUCTS_QUERY in backup.server.ts so before/after diff is apples-to-apples.
// (This is the products(first:50){nodes{...}} selection collapsed onto product(id:$id){...}.)
const PRODUCT_DIFF_QUERY = `#graphql
  query GetProductForDiff($id: ID!) {
    product(id: $id) {
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
`;

// Top-level keys we actually back up and could revert. Diff is restricted to this
// allow-list (and deliberately excludes `id`, which is always equal) to avoid noise
// from server-only/echoed fields. Stable order so the UIs render fields consistently.
const DIFF_FIELDS = [
  "title",
  "handle",
  "descriptionHtml",
  "productType",
  "vendor",
  "tags",
  "status",
  "templateSuffix",
  "category",
  "options",
  "variants",
  "images",
  "metafields",
  "seo",
];

const TRUNCATE = 80;

/**
 * Stringify a value and truncate to <= TRUNCATE chars with a trailing ellipsis.
 */
function short(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE - 1) + "…" : s;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId");

  if (!resourceId) {
    return cors(json({ error: "resourceId required" }, { status: 400 }));
  }

  try {
    // Find the most recent COMPLETED backup item for this resource
    const latestBackupItem = await prisma.backupItem.findFirst({
      where: {
        resourceId,
        resourceType: "PRODUCT",
        backup: { storeId: session.shop, status: "COMPLETED" },
      },
      orderBy: { backup: { createdAt: "desc" } },
      include: { backup: { select: { createdAt: true } } },
    });

    // No-backup short-circuit
    if (!latestBackupItem) {
      return cors(
        json({
          hasBackup: false,
          changed: false,
          backupItemId: null,
          lastBackedUp: null,
          changedFields: [],
        }),
      );
    }

    // Load the backed-up product JSON from storage. Degrade gracefully (read-only
    // status probe) to a no-backup response if the blob is missing/unreadable.
    const raw = await storage.get(latestBackupItem.storagePath);
    if (!raw) {
      return cors(
        json({
          hasBackup: false,
          changed: false,
          backupItemId: null,
          lastBackedUp: null,
          changedFields: [],
        }),
      );
    }

    const backupData = JSON.parse(raw) as Record<string, unknown>;

    // Fetch the current product from Shopify with the SAME field shape as PRODUCTS_QUERY.
    const resp = await admin.graphql(PRODUCT_DIFF_QUERY, {
      variables: { id: resourceId },
    });
    const result = await resp.json();
    const liveProduct = result.data?.product as Record<string, unknown> | null;

    // Product was deleted — nothing to "undo" via the revert flow. Recovering a
    // deleted product is the job of restore-product / recover-deleted-action.
    if (!liveProduct) {
      return cors(
        json({
          hasBackup: true,
          changed: false,
          deleted: true,
          backupItemId: latestBackupItem.id,
          lastBackedUp: latestBackupItem.backup.createdAt.toISOString(),
          changedFields: [],
        }),
      );
    }

    // Compute changed top-level fields (shallow stringify compare per DIFF_FIELDS key).
    // Caveat: `tags` may come back in a different array order between backup and live,
    // so this compare can flag it as changed even when the set is equal. Acceptable for
    // v1 — computeChangedFields in changelog.server.ts has the same limitation.
    const changedFields: Array<{ field: string; before: string; after: string }> = [];
    for (const field of DIFF_FIELDS) {
      const before = backupData[field];
      const after = liveProduct[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changedFields.push({ field, before: short(before), after: short(after) });
      }
    }
    const changed = changedFields.length > 0;

    return cors(
      json({
        hasBackup: true,
        changed,
        backupItemId: latestBackupItem.id,
        lastBackedUp: latestBackupItem.backup.createdAt.toISOString(),
        changedFields,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error: error instanceof Error ? error.message : "Product diff failed",
        },
        { status: 500 },
      ),
    );
  }
};

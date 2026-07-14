import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * API endpoint for the Backup Status admin block extension.
 * Returns the backup status for a specific resource (product).
 *
 * GET /api/backup-status?resourceId=gid://shopify/Product/123
 */

// REST webhook payload keys that bump on essentially every update and aren't
// user-facing changes. Mirrors NOISE_KEYS in api.product-history.tsx.
const NOISE_KEYS = new Set([
  "id",
  "admin_graphql_api_id",
  "created_at",
  "updated_at",
  "published_scope",
  "variant_ids",
  "variant_gids",
  "image",
  "image_id",
]);

/**
 * Does this event still carry a visible change the merchant hasn't undone via
 * per-field Undo? Same approximation as api.changed-products.tsx (kept in
 * sync so the badge and the changed-products list agree): undoneFields holds
 * granular tokens, changedFields top-level REST keys, so variants/metafields
 * coverage is judged by token family.
 */
function hasActiveChange(
  changedFields: string[],
  undoneFields: string[],
): boolean {
  // Legacy rows recorded without a diff — assume still relevant.
  if (changedFields.length === 0) return true;
  const visible = changedFields.filter((f) => !NOISE_KEYS.has(f));
  return visible.some((f) => {
    if (undoneFields.includes(f)) return false;
    if (f === "variants" && undoneFields.some((u) => u.startsWith("variant:"))) {
      return false;
    }
    if (
      f === "metafields" &&
      undoneFields.some((u) => u.startsWith("metafield:"))
    ) {
      return false;
    }
    return true;
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId");

  if (!resourceId) {
    return cors(json({ error: "resourceId required" }, { status: 400 }));
  }

  // Find the most recent backup item for this resource
  const latestBackupItem = await prisma.backupItem.findFirst({
    where: {
      resourceId,
      backup: { storeId: session.shop, status: "COMPLETED" },
    },
    orderBy: { backup: { createdAt: "desc" } },
    include: { backup: { select: { createdAt: true } } },
  });

  // Count recent changes for this resource (premium tier). Skip hidden
  // (revert-generated / reverted-to-backup) events and events whose every
  // visible field the merchant undid per-field, so this badge agrees with
  // the changed-products list and the undo timeline.
  const recentRows = await prisma.changeLog.findMany({
    where: {
      storeId: session.shop,
      resourceId,
      hidden: false,
      changedAt: latestBackupItem?.backup.createdAt
        ? { gt: latestBackupItem.backup.createdAt }
        : undefined,
    },
    orderBy: { changedAt: "desc" },
    select: { changedFields: true, undoneFields: true },
    take: 500,
  });
  const recentChanges = recentRows.filter((row) =>
    hasActiveChange(row.changedFields, row.undoneFields),
  ).length;

  return cors(
    json({
      backupItemId: latestBackupItem?.id || null,
      lastBackedUp: latestBackupItem?.backup.createdAt.toISOString() || null,
      recentChanges,
    }),
  );
};

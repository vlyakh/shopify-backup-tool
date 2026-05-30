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

  // Count recent changes for this resource (premium tier)
  const recentChanges = await prisma.changeLog.count({
    where: {
      storeId: session.shop,
      resourceId,
      changedAt: latestBackupItem?.backup.createdAt
        ? { gt: latestBackupItem.backup.createdAt }
        : undefined,
    },
  });

  return cors(
    json({
      backupItemId: latestBackupItem?.id || null,
      lastBackedUp: latestBackupItem?.backup.createdAt.toISOString() || null,
      recentChanges,
    }),
  );
};

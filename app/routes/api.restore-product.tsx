import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { restoreItems } from "../services/restore.server";

/**
 * API endpoint for the Recover Deleted Products extension.
 * Restores a single product from a backup item.
 *
 * POST /api/restore-product
 * Body: { backupItemId: string }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, cors } = await authenticate.admin(request);

  const body = await request.json();
  const { backupItemId } = body;

  if (!backupItemId) {
    return cors(json({ error: "backupItemId required" }, { status: 400 }));
  }

  try {
    const results = await restoreItems(admin, [backupItemId]);
    const result = results[0];

    if (!result) {
      return cors(json({ error: "Backup item not found" }, { status: 404 }));
    }

    if (!result.success) {
      return cors(
        json({ error: result.error || "Restore failed" }, { status: 500 }),
      );
    }

    return cors(
      json({
        success: true,
        newProductId: result.newResourceId,
        title: result.title,
      }),
    );
  } catch (error) {
    return cors(
      json(
        { error: error instanceof Error ? error.message : "Restore failed" },
        { status: 500 },
      ),
    );
  }
};

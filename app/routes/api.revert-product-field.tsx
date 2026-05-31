import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { reconcileProductImages } from "../services/product-revert.server";

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation productVariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
      allowPartialUpdates: true
    ) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

/**
 * CORS preflight — extensions POST here cross-origin (see api.revert-product.tsx
 * for the full rationale; a loader is required so OPTIONS reaches authenticate.admin).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(json({ error: "Method not allowed" }, { status: 405 }));
};

type Target =
  | { kind: "product"; field: string }
  | { kind: "variant"; variantId: string; field: string };

/**
 * Reverts a SINGLE change of a product back to its backed-up value — the
 * per-change Undo (revert just the price, keep the title). `target` comes
 * verbatim from a change in /api/product-diff.
 *
 * POST /api/revert-product-field
 * Body: { backupItemId: string, target: Target }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);
  const body = await request.json();
  const backupItemId: string | undefined = body.backupItemId;
  const target: Target | undefined = body.target;

  if (!backupItemId || !target) {
    return cors(
      json({ error: "backupItemId and target required" }, { status: 400 }),
    );
  }

  const backupItem = await prisma.backupItem.findFirst({
    where: {
      id: backupItemId,
      resourceType: "PRODUCT",
      backup: { storeId: session.shop },
    },
  });
  if (!backupItem) {
    return cors(json({ error: "Backup item not found" }, { status: 404 }));
  }
  const raw = await storage.get(backupItem.storagePath);
  if (!raw) {
    return cors(
      json({ error: "Backup data not found in storage" }, { status: 404 }),
    );
  }
  const data = JSON.parse(raw);
  const productId = backupItem.resourceId;

  try {
    if (target.kind === "product") {
      // Images: reconcile media to the backup (best-effort, never blocks).
      if (target.field === "images") {
        const warnings = await reconcileProductImages(
          admin,
          productId,
          data.images?.nodes ?? [],
        );
        return cors(
          json({ success: true, warnings: warnings.length ? warnings : undefined }),
        );
      }

      // Scalar / category / seo / tags → productUpdate with just that field.
      const productInput: Record<string, unknown> = { id: productId };
      if (target.field === "category") {
        // The ".../na" Uncategorized sentinel isn't assignable — null clears it.
        const id = (data.category as { id?: string } | null)?.id;
        productInput.category = id && !id.endsWith("/na") ? id : null;
      } else {
        productInput[target.field] = data[target.field];
      }

      const result = await (
        await admin.graphql(PRODUCT_UPDATE_MUTATION, {
          variables: { product: productInput },
        })
      ).json();
      const errs = [
        ...((result.data?.productUpdate?.userErrors ?? []) as Array<{
          message: string;
        }>),
        ...((result as { errors?: Array<{ message: string }> }).errors ?? []),
      ].map((e) => e.message);
      if (errs.length) return cors(json({ error: errs.join(", ") }, { status: 500 }));
      return cors(json({ success: true }));
    }

    if (target.kind === "variant") {
      const variant = (
        (data.variants?.nodes ?? []) as Array<Record<string, unknown>>
      ).find((v) => v.id === target.variantId);
      if (!variant) {
        return cors(
          json({ error: "Variant not found in backup" }, { status: 404 }),
        );
      }
      const input: Record<string, unknown> = { id: target.variantId };
      if (target.field === "sku") {
        // sku is an InventoryItem field in 2026-04 (needs write_inventory).
        input.inventoryItem = { sku: variant.sku };
      } else {
        input[target.field] = variant[target.field];
      }

      const result = await (
        await admin.graphql(VARIANTS_BULK_UPDATE_MUTATION, {
          variables: { productId, variants: [input] },
        })
      ).json();
      const errs = [
        ...((result.data?.productVariantsBulkUpdate?.userErrors ?? []) as Array<{
          message: string;
        }>),
        ...((result as { errors?: Array<{ message: string }> }).errors ?? []),
      ].map((e) => e.message);
      if (errs.length) return cors(json({ error: errs.join(", ") }, { status: 500 }));
      return cors(json({ success: true }));
    }

    return cors(json({ error: "Unknown target" }, { status: 400 }));
  } catch (error) {
    return cors(
      json(
        { error: error instanceof Error ? error.message : "Revert failed" },
        { status: 500 },
      ),
    );
  }
};

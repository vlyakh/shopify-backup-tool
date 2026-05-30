import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation productVariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
    $allowPartialUpdates: Boolean
  ) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
      allowPartialUpdates: $allowPartialUpdates
    ) {
      product {
        id
      }
      productVariants {
        id
        sku
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * API endpoint for reverting a product to its backed-up state.
 * Unlike /api/restore-product which creates a new Draft, this OVERWRITES
 * the existing product with backed-up data using productUpdate + productVariantsBulkUpdate.
 *
 * POST /api/revert-product
 * Body: { backupItemId: string }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);

  const body = await request.json();
  const { backupItemId } = body;

  if (!backupItemId) {
    return cors(json({ error: "backupItemId required" }, { status: 400 }));
  }

  // Load backup item and its data
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
  const productId = backupItem.resourceId; // GID like gid://shopify/Product/123

  try {
    // Step 1: Update product-level fields
    const productInput: Record<string, unknown> = {
      id: productId,
      title: data.title,
      descriptionHtml: data.descriptionHtml,
      productType: data.productType,
      vendor: data.vendor,
      tags: data.tags,
      templateSuffix: data.templateSuffix,
    };

    if (data.seo) {
      productInput.seo = data.seo;
    }

    const productResponse = await admin.graphql(PRODUCT_UPDATE_MUTATION, {
      variables: { product: productInput },
    });
    const productResult = await productResponse.json();
    const productErrors =
      productResult.data?.productUpdate?.userErrors || [];

    if (productErrors.length > 0) {
      return cors(
        json(
          {
            error: `Product update failed: ${productErrors.map((e: { message: string }) => e.message).join(", ")}`,
          },
          { status: 500 },
        ),
      );
    }

    // Step 2: Update variants via bulk update
    const variants = data.variants as
      | { nodes: Array<Record<string, unknown>> }
      | undefined;

    let variantErrors: string[] = [];

    if (variants?.nodes?.length) {
      const variantInputs = variants.nodes
        .filter((v) => v.id) // Only update variants that have an ID (existing ones)
        .map((v) => {
          // Weight, requiresShipping and tracked live under inventoryItem in
          // 2026-04 (weight/weightUnit were removed from ProductVariant).
          const inv = v.inventoryItem as
            | {
                tracked?: boolean;
                requiresShipping?: boolean;
                measurement?: { weight?: { value: number; unit: string } };
              }
            | undefined;

          const inventoryItem: Record<string, unknown> = {};
          if (inv?.tracked !== undefined) inventoryItem.tracked = inv.tracked;
          if (inv?.requiresShipping !== undefined)
            inventoryItem.requiresShipping = inv.requiresShipping;
          if (inv?.measurement?.weight) {
            inventoryItem.measurement = {
              weight: {
                value: inv.measurement.weight.value,
                unit: inv.measurement.weight.unit,
              },
            };
          }

          return {
            id: v.id,
            sku: v.sku,
            barcode: v.barcode,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            taxable: v.taxable,
            ...(Object.keys(inventoryItem).length ? { inventoryItem } : {}),
          };
        });

      if (variantInputs.length > 0) {
        const variantResponse = await admin.graphql(
          VARIANTS_BULK_UPDATE_MUTATION,
          {
            variables: {
              productId,
              variants: variantInputs,
              allowPartialUpdates: true, // Don't fail if some variants were deleted
            },
          },
        );
        const variantResult = await variantResponse.json();
        const vErrors =
          variantResult.data?.productVariantsBulkUpdate?.userErrors || [];

        if (vErrors.length > 0) {
          variantErrors = vErrors.map(
            (e: { message: string }) => e.message,
          );
        }
      }
    }

    return cors(
      json({
        success: true,
        productId,
        title: data.title,
        variantWarnings:
          variantErrors.length > 0 ? variantErrors : undefined,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error: error instanceof Error ? error.message : "Revert failed",
        },
        { status: 500 },
      ),
    );
  }
};

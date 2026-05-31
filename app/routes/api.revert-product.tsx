import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { imageSignature } from "../services/image-signature.server";

/**
 * CORS preflight handler. Admin UI extensions are served cross-origin from
 * extensions.shopifycdn.com and send an Authorization: Bearer session token,
 * so every call here is preceded by a CORS preflight (OPTIONS). Remix routes
 * OPTIONS to the *loader* — and a route with only an `action` answers it with
 * a bare 400 that has no Access-Control-* headers, so the preflight fails and
 * the POST never fires. authenticate.admin short-circuits OPTIONS with a 204 +
 * the right CORS headers (before any token check), so simply running it here
 * makes the preflight pass. A real GET isn't a use of this endpoint → 405.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(json({ error: "Method not allowed" }, { status: 405 }));
};

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

// --- Media (image) restore ops, 2026-04 ---
// There is no in-place "replace media" mutation (productUpdate.media only APPENDS),
// so reverting images means reconciling: read the product's CURRENT media, delete
// it, then re-create from the backed-up image URLs. The media `id` stored in the
// backup is from backup time and is STALE, so deletion must use ids read live here.
const PRODUCT_MEDIA_QUERY = `#graphql
  query GetProductMedia($id: ID!) {
    product(id: $id) {
      media(first: 250) {
        nodes {
          id
          mediaContentType
          ... on MediaImage {
            image {
              altText
              width
              height
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_DELETE_MEDIA_MUTATION = `#graphql
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

// CreateMediaInput uses `originalSource` + `mediaContentType` + `alt`. Note
// `mediaContentType` (NOT `contentType`, which is the ProductSetInput.files
// spelling). A cdn.shopify.com URL is a valid originalSource and re-ingests a copy.
const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        status
        mediaContentType
      }
      mediaUserErrors {
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
    // The "Uncategorized" placeholder category (id ".../na") is the "no category"
    // sentinel and is NOT an assignable id, so map it (and a missing category) to
    // null — reverting to Uncategorized means CLEARING the category, not assigning
    // the sentinel (which would error).
    const backupCategoryId = (data.category as { id?: string } | null)?.id;
    const categoryValue =
      backupCategoryId && !backupCategoryId.endsWith("/na")
        ? backupCategoryId
        : null;

    // Step 1: Update product-level fields. productUpdate is non-destructive (it
    // only touches the fields passed) — unlike productSet, which treats variants
    // as a full set and would DELETE any variant beyond the backup's 100-variant
    // cap. category/status/handle were previously missing, so they never reverted.
    const productInput: Record<string, unknown> = {
      id: productId,
      title: data.title,
      descriptionHtml: data.descriptionHtml,
      productType: data.productType,
      vendor: data.vendor,
      tags: data.tags,
      templateSuffix: data.templateSuffix,
      category: categoryValue, // ProductUpdateInput.category: ID (or null to clear)
      status: data.status, // ProductStatus enum (ACTIVE/DRAFT/ARCHIVED)
      handle: data.handle, // may be silently uniquified if the handle is taken
    };

    if (data.seo) {
      productInput.seo = data.seo;
    }

    // Metafields: upsert by namespace+key (id not required). This reverts changed
    // values and re-adds deleted ones, but is ADDITIVE — it does NOT remove
    // metafields the user added after the backup (productUpdate can't full-set
    // them; productSet could, but we avoid it for its variant-deletion risk).
    const metafieldNodes = (
      data.metafields as
        | {
            nodes?: Array<{
              namespace?: string;
              key?: string;
              value?: string;
              type?: string;
            }>;
          }
        | undefined
    )?.nodes;
    if (metafieldNodes?.length) {
      productInput.metafields = metafieldNodes.map((m) => ({
        namespace: m.namespace,
        key: m.key,
        value: m.value,
        type: m.type,
      }));
    }

    const productResponse = await admin.graphql(PRODUCT_UPDATE_MUTATION, {
      variables: { product: productInput },
    });
    const productResult = await productResponse.json();
    // Include the TOP-LEVEL GraphQL `errors` array, not just userErrors — that's
    // where access-denied (e.g. a missing scope) lands, and it was being swallowed.
    const productErrors = [
      ...(productResult.data?.productUpdate?.userErrors || []),
      ...(productResult.errors || []),
    ] as Array<{ message: string }>;

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
          // sku moved onto InventoryItemInput in 2026-04 — it is NOT a field on
          // ProductVariantsBulkInput, so productVariantsBulkUpdate rejects a
          // top-level sku ("Field is not defined on ProductVariantsBulkInput").
          if (v.sku !== undefined && v.sku !== null) inventoryItem.sku = v.sku;
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
        // userErrors + top-level GraphQL errors. SKU/weight/tracked are
        // InventoryItem fields and require write_inventory; without it Shopify
        // returns a top-level "Access denied … write_inventory" error (and drops
        // the inventoryItem block) — surfacing it here turns the old silent SKU
        // no-op into a visible warning instead of a false success.
        const vErrors = [
          ...(variantResult.data?.productVariantsBulkUpdate?.userErrors || []),
          ...(variantResult.errors || []),
        ] as Array<{ message: string }>;

        if (vErrors.length > 0) {
          variantErrors = vErrors.map((e) => e.message);
        }
      }
    }

    // Step 3: Restore product images (best-effort — must never block the
    // title/variant revert above, so failures collect into mediaWarnings instead
    // of throwing). Scope is IMAGE only (the backup captures the legacy `images`
    // connection; video/3D media isn't backed up).
    //
    // Shopify has no in-place "replace media" mutation, so we reconcile against
    // the CURRENT media (the backup's media ids/urls are stale). Two correctness
    // details, both learned the hard way:
    //  - Compare by a STABLE signature (dimensions + altText + order), NOT urls or
    //    filenames: productCreateMedia re-ingests each image under a NEW url/id
    //    AND a uniquified filename, so any url/name compare would read a just-
    //    reverted product as "changed" forever and duplicate images every revert.
    //  - CREATE first, then delete the old media only once the full backup set was
    //    accepted — so a failed create never leaves the product imageless.
    const mediaWarnings: string[] = [];
    try {
      const backupImages: Array<{
        url?: string;
        altText?: string | null;
        width?: number | null;
        height?: number | null;
      }> = (data.images?.nodes ?? []).filter((img: { url?: string }) => img.url);

      // Read the product's CURRENT image media (node ids to delete; dimensions +
      // altText to compare against the backup).
      const mediaResponse = await admin.graphql(PRODUCT_MEDIA_QUERY, {
        variables: { id: productId },
      });
      const mediaResult = await mediaResponse.json();
      const currentImages = (
        (mediaResult.data?.product?.media?.nodes ?? []) as Array<{
          id: string;
          mediaContentType?: string;
          image?: {
            altText?: string | null;
            width?: number | null;
            height?: number | null;
          };
        }>
      ).filter((n) => n.mediaContentType === "IMAGE");

      const currentSignature = imageSignature(
        currentImages.map((n) => n.image ?? {}),
      );
      const backupSignature = imageSignature(backupImages);

      if (currentSignature !== backupSignature) {
        // Create the backed-up images FIRST (this appends), then remove the old
        // ones — so a create failure never leaves the product imageless.
        let createdCount = 0;
        if (backupImages.length > 0) {
          const createResult = await (
            await admin.graphql(PRODUCT_CREATE_MEDIA_MUTATION, {
              variables: {
                productId,
                media: backupImages.map((img) => ({
                  originalSource: img.url,
                  alt: img.altText || "",
                  mediaContentType: "IMAGE",
                })),
              },
            })
          ).json();
          for (const e of (createResult.data?.productCreateMedia
            ?.mediaUserErrors ?? []) as Array<{ message: string }>) {
            mediaWarnings.push(`Image restore: ${e.message}`);
          }
          createdCount =
            createResult.data?.productCreateMedia?.media?.length ?? 0;
        }

        // Remove the OLD images only when the whole backup set was created (or the
        // backup had none → an intentionally empty gallery). On a partial/failed
        // create, keep the originals so nothing is lost (may leave duplicates).
        const fullyCreated = createdCount === backupImages.length;
        if (fullyCreated && currentImages.length > 0) {
          const deleteResult = await (
            await admin.graphql(PRODUCT_DELETE_MEDIA_MUTATION, {
              variables: { productId, mediaIds: currentImages.map((n) => n.id) },
            })
          ).json();
          for (const e of (deleteResult.data?.productDeleteMedia
            ?.mediaUserErrors ?? []) as Array<{ message: string }>) {
            mediaWarnings.push(`Image delete: ${e.message}`);
          }
        } else if (!fullyCreated) {
          mediaWarnings.push(
            "Some images could not be restored from the backup; kept the product's existing images.",
          );
        }
      }
    } catch (mediaError) {
      mediaWarnings.push(
        mediaError instanceof Error ? mediaError.message : "Image restore failed",
      );
    }

    return cors(
      json({
        success: true,
        productId,
        title: data.title,
        variantWarnings:
          variantErrors.length > 0 ? variantErrors : undefined,
        mediaWarnings: mediaWarnings.length > 0 ? mediaWarnings : undefined,
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

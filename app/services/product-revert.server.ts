import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { imageSignature } from "./image-signature.server";

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

type BackupImage = {
  url?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Best-effort reconcile of a product's images to a backup set. Create-first then
 * delete-old (never leaves the product imageless), compared by a stable
 * dimensions+altText signature so it's idempotent across Shopify's re-ingestion
 * (which changes urls/ids/filenames). Returns warnings; never throws.
 *
 * Mirrors Step 3 of api.revert-product.tsx — kept here so the per-field revert
 * endpoint can reuse it without re-deriving the subtle media logic.
 */
export async function reconcileProductImages(
  admin: AdminApiContext,
  productId: string,
  backupImageNodes: BackupImage[],
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const backupImages = backupImageNodes.filter((img) => img.url);

    const mediaResult = await (
      await admin.graphql(PRODUCT_MEDIA_QUERY, {
        variables: { id: productId },
      })
    ).json();
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
    if (currentSignature === backupSignature) return warnings;

    // Create the backed-up images first (append), then delete the old ones only
    // once the full set was accepted — so a failed create never leaves the
    // product imageless.
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
      for (const e of (createResult.data?.productCreateMedia?.mediaUserErrors ??
        []) as Array<{ message: string }>) {
        warnings.push(`Image restore: ${e.message}`);
      }
      createdCount = createResult.data?.productCreateMedia?.media?.length ?? 0;
    }

    const fullyCreated = createdCount === backupImages.length;
    if (fullyCreated && currentImages.length > 0) {
      const deleteResult = await (
        await admin.graphql(PRODUCT_DELETE_MEDIA_MUTATION, {
          variables: { productId, mediaIds: currentImages.map((n) => n.id) },
        })
      ).json();
      for (const e of (deleteResult.data?.productDeleteMedia?.mediaUserErrors ??
        []) as Array<{ message: string }>) {
        warnings.push(`Image delete: ${e.message}`);
      }
    } else if (!fullyCreated) {
      warnings.push(
        "Some images could not be restored from the backup; kept the product's existing images.",
      );
    }
  } catch (error) {
    warnings.push(
      error instanceof Error ? error.message : "Image restore failed",
    );
  }
  return warnings;
}

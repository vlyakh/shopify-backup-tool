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

const PRODUCT_MEDIA_STATUS_QUERY = `#graphql
  query GetProductMediaStatus($id: ID!) {
    product(id: $id) {
      media(first: 250) {
        nodes {
          id
          status
        }
      }
    }
  }
`;

const MEDIA_POLL_INTERVAL_MS = 3000;
// Shopify fetches media sources asynchronously and large image sets routinely
// take well over 30s to all reach READY, so the deadline must be generous —
// and expiring it is NOT treated as a failure (see waitForMediaReady): the
// media are almost always fine, just still ingesting.
const MEDIA_POLL_TIMEOUT_MS = 120_000;

/**
 * How long the revert routes must arm their echo-hiding burst window
 * (suppressWebhooksFor) BEFORE calling reconcileProductImages: the reconcile
 * can block in waitForMediaReady for up to MEDIA_POLL_TIMEOUT_MS, and the
 * default 10s window would expire mid-poll — the products/update echo Shopify
 * fires when the new media turn READY and attach would then record as a
 * VISIBLE phantom change (and its arrival deletes the stale mark, so the
 * post-reconcile refresh can't rescue it). Poll timeout + slack for one poll
 * overshoot and the surrounding queries/mutations. Callers refresh the window
 * right after the reconcile returns, which SHORTENS it back to the default
 * tail — so the long window only outlives a reconcile that is actually
 * blocked polling.
 */
export const IMAGE_RECONCILE_SUPPRESS_MS = MEDIA_POLL_TIMEOUT_MS + 15_000;

type MediaWaitOutcome = "ready" | "failed" | "timeout";

/**
 * productCreateMedia only ACCEPTS media — Shopify fetches the sources
 * asynchronously, and a media can still transition to FAILED afterwards. Poll
 * until every given media is READY ("ready"), any is FAILED ("failed"), or
 * the deadline elapses ("timeout"). The last two are deliberately distinct:
 * a deadline expiry — media still PROCESSING, or polls that returned only
 * top-level GraphQL errors (throttling), which leave `pending` untouched —
 * says NOTHING about the media being bad, so callers must not treat it like
 * a failure.
 */
async function waitForMediaReady(
  admin: AdminApiContext,
  productId: string,
  mediaIds: string[],
): Promise<MediaWaitOutcome> {
  const deadline = Date.now() + MEDIA_POLL_TIMEOUT_MS;
  const pending = new Set(mediaIds);
  for (;;) {
    const result = await (
      await admin.graphql(PRODUCT_MEDIA_STATUS_QUERY, {
        variables: { id: productId },
      })
    ).json();
    const nodes = (result.data?.product?.media?.nodes ?? []) as Array<{
      id: string;
      status?: string;
    }>;
    for (const n of nodes) {
      if (!pending.has(n.id)) continue;
      if (n.status === "FAILED") return "failed";
      if (n.status === "READY") pending.delete(n.id);
    }
    if (pending.size === 0) return "ready";
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_INTERVAL_MS));
  }
}

type BackupImage = {
  url?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Best-effort reconcile of a product's images to a backup set. Create-first,
 * wait for the new media to finish ingesting (READY), then delete-old (never
 * leaves the product imageless), compared by a stable dimensions+altText
 * signature so it's idempotent across Shopify's re-ingestion (which changes
 * urls/ids/filenames). A FAILED ingest rolls the new media back; a mere poll
 * TIMEOUT keeps both sets (rolling back would make slow-ingesting sets
 * deterministically unrestorable) and a re-run converges via the signature.
 * Returns warnings; never throws.
 *
 * The single shared implementation of the media revert: both Step 3 of
 * api.revert-product.tsx (revert-all) and the per-field images revert
 * (api.revert-product-field.tsx) call it, so the create-first / READY-wait /
 * rollback behavior cannot drift between the two paths.
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
    // once the full set was accepted AND finished ingesting — so a failed
    // create never leaves the product imageless.
    let createdCount = 0;
    let createdIds: string[] = [];
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
      const createdMedia = (createResult.data?.productCreateMedia?.media ??
        []) as Array<{ id: string }>;
      createdCount = createdMedia.length;
      createdIds = createdMedia.map((m) => m.id);
    }

    const fullyCreated = createdCount === backupImages.length;
    if (fullyCreated && currentImages.length > 0) {
      // Deleting the old images while a new one could still transition to
      // FAILED would lose them for good — wait for ingestion to finish first.
      const outcome: MediaWaitOutcome =
        createdIds.length === 0
          ? "ready"
          : await waitForMediaReady(admin, productId, createdIds);
      if (outcome === "ready") {
        const deleteResult = await (
          await admin.graphql(PRODUCT_DELETE_MEDIA_MUTATION, {
            variables: { productId, mediaIds: currentImages.map((n) => n.id) },
          })
        ).json();
        for (const e of (deleteResult.data?.productDeleteMedia
          ?.mediaUserErrors ?? []) as Array<{ message: string }>) {
          warnings.push(`Image delete: ${e.message}`);
        }
      } else if (outcome === "failed") {
        // Roll back the failed new media (best-effort) and keep the old.
        try {
          await admin.graphql(PRODUCT_DELETE_MEDIA_MUTATION, {
            variables: { productId, mediaIds: createdIds },
          });
        } catch {
          // best-effort — worst case the product carries extra failed media
        }
        warnings.push(
          "Some images could not be restored from the backup; kept the product's existing images.",
        );
      } else {
        // Timeout: every new media was ACCEPTED and none has FAILED — they're
        // just still ingesting (or the status polls were throttled). Rolling
        // them back here would destroy an almost-certainly-successful create,
        // and every retry would hit the same wall, making the revert
        // permanently impossible for slow-ingesting sets. Deleting the OLD set
        // instead could sever the very CDN sources the new media are still
        // fetching from. So keep BOTH sets and warn: a re-run sees the
        // mismatch via the signature and, once its READY-wait succeeds,
        // deletes every pre-existing image (old set + any stale copies) in
        // one pass.
        warnings.push(
          "Restored images are still being processed by Shopify; the product's previous images were kept alongside them for now — run the revert again in a minute to finish cleaning up.",
        );
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

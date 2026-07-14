import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import {
  IMAGE_RECONCILE_SUPPRESS_MS,
  reconcileProductImages,
} from "../services/product-revert.server";
import {
  clearSuppressionWindow,
  suppressWebhooksFor,
} from "../services/revert-bookkeeping.server";

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

  // True while the pre-armed burst window has no successful write behind it.
  // The error paths must disarm it — a failed revert produces no echo, and a
  // leftover window would hide (hidden=true) real merchant edits made in its
  // remaining ~10s.
  let preArmedWindow = false;
  try {
    // The revert fires several writes (product + variants + media), each
    // echoing a products/update webhook that can be DELIVERED while the run is
    // still going — and the variant write's inventoryItem fields (cost / HS
    // code / origin / weight) additionally echo inventory_items/update, which
    // the processor attributes to this same product GID, so this window hides
    // those echoes too. consumeSuppression only matches webhooks delivered AT
    // OR AFTER the mark was armed: open the echo-hiding burst window BEFORE
    // the first write and refresh it after the last, like the images path in
    // revert-product-field; arming only at the end would record every
    // mid-run echo as a visible change. windowAnchor is passed to every
    // refresh below so a lapsed segment (throttled writes can outlast 10s)
    // can't reset the armedAt lower bound past echoes already delivered.
    const windowAnchor = new Date();
    await suppressWebhooksFor(session.shop, productId, 10_000, windowAnchor);
    preArmedWindow = true;

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
      ...((productResult as { errors?: Array<{ message: string }> }).errors ||
        []),
    ] as Array<{ message: string }>;

    if (productErrors.length > 0) {
      // productUpdate failed (userErrors → nothing applied), so no echo is
      // coming — disarm the pre-armed window so it can't hide real merchant
      // edits made right after the error.
      await clearSuppressionWindow(session.shop, productId);
      return cors(
        json(
          {
            error: `Product update failed: ${productErrors.map((e: { message: string }) => e.message).join(", ")}`,
          },
          { status: 500 },
        ),
      );
    }
    // The product write applied — its echo IS coming, so from here on the
    // window must stay armed even if a later step fails.
    preArmedWindow = false;

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
                unitCost?: { amount?: unknown } | null;
                harmonizedSystemCode?: string | null;
                countryCodeOfOrigin?: string | null;
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
          // Cost / HS code / origin are captured by the backup and tracked in
          // the ledger (via inventory_items/update), so revert-all must write
          // them back too — their ledger rows get hidden below as undone.
          // InventoryItemInput.cost is a Decimal — pass it as a string; an
          // explicit null clears a value that was added after the backup.
          if (inv?.unitCost !== undefined) {
            inventoryItem.cost =
              inv.unitCost?.amount != null ? String(inv.unitCost.amount) : null;
          }
          if (inv?.harmonizedSystemCode !== undefined)
            inventoryItem.harmonizedSystemCode = inv.harmonizedSystemCode;
          if (inv?.countryCodeOfOrigin !== undefined)
            inventoryItem.countryCodeOfOrigin = inv.countryCodeOfOrigin;
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
          ...((variantResult as { errors?: Array<{ message: string }> })
            .errors || []),
        ] as Array<{ message: string }>;

        if (vErrors.length > 0) {
          variantErrors = vErrors.map((e) => e.message);
        }
      }
    }

    // Keep the burst window alive across the media reconcile below — it can
    // block up to ~2min in waitForMediaReady (media ingestion), and the window
    // opened before Step 1 is only 10s. Arm it for the poll timeout + slack so
    // the products/update echo fired when the media turn READY can't land in
    // an expired-window gap; the refresh after the reconcile shortens it back
    // to the normal ~10s tail. windowAnchor keeps the run's original armedAt
    // even if the Step 1-2 segment outlasted the first 10s window, so echoes
    // delivered during that lapse still match.
    await suppressWebhooksFor(
      session.shop,
      productId,
      IMAGE_RECONCILE_SUPPRESS_MS,
      windowAnchor,
    );

    // Step 3: Restore product images (best-effort — must never block the
    // title/variant revert above; the helper never throws and returns failures
    // as warnings). Scope is IMAGE only (the backup captures the legacy
    // `images` connection; video/3D media isn't backed up). All the subtle
    // media logic lives in reconcileProductImages, SHARED with the per-field
    // images revert so the two paths can't drift: stable signature compare
    // (urls/ids/filenames change on re-ingestion), create-first, and — since
    // productCreateMedia only ACCEPTS media and ingestion is async — wait for
    // every new media to reach READY before deleting the old set, rolling the
    // new ones back on FAILED so the product is never left imageless (a mere
    // poll timeout keeps both sets and warns, so a re-run can converge).
    const mediaWarnings = await reconcileProductImages(
      admin,
      productId,
      data.images?.nodes ?? [],
    );

    // The product now matches this backup, so every change since it is undone:
    // hide those history events, and hide the webhooks our revert just fired
    // (they're recorded so the baseline advances, but flagged hidden).
    const backup = await prisma.backup.findUnique({
      where: { id: backupItem.backupId },
      select: { createdAt: true },
    });
    if (backup) {
      await prisma.changeLog.updateMany({
        where: {
          storeId: session.shop,
          resourceType: "PRODUCT",
          resourceId: productId,
          changedAt: { gt: backup.createdAt },
        },
        data: { hidden: true },
      });
    }
    // Refresh the burst window opened before the writes, so echoes Shopify
    // delivers AFTER this point still land inside it (windowAnchor preserves
    // the run's original armedAt even across a lapsed segment).
    await suppressWebhooksFor(session.shop, productId, 10_000, windowAnchor);

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
    if (preArmedWindow) {
      // No write succeeded before the failure, so no echo may ever arrive —
      // don't leave the pre-armed window hiding real merchant edits.
      try {
        await clearSuppressionWindow(session.shop, productId);
      } catch {
        // best-effort — the original error below is the one to surface,
        // and the window self-expires in ~10s anyway
      }
    }
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

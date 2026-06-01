import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { reconcileProductImages } from "../services/product-revert.server";
import {
  suppressNextWebhook,
  markUndone,
} from "../services/revert-bookkeeping.server";

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

  // Path 1 — revert a single PAST EDIT to its before-value (change history /
  // /api/product-history). Source is the ChangeLog event's BEFORE snapshot, which
  // is a REST webhook payload (snake_case) — so it needs REST→GraphQL translation,
  // unlike the backup path below (GraphQL camelCase). Sets the field to what it
  // was immediately before that edit; other fields are untouched.
  if (typeof body.changeId === "string" && typeof body.field === "string") {
    const changeId: string = body.changeId;
    const field: string = body.field;

    const change = await prisma.changeLog.findFirst({
      where: { id: changeId, storeId: session.shop, resourceType: "PRODUCT" },
    });
    if (!change) return cors(json({ error: "Change not found" }, { status: 404 }));
    if (!change.beforePath) {
      return cors(
        json({ error: "No prior snapshot to revert to" }, { status: 422 }),
      );
    }
    const beforeRaw = await storage.get(change.beforePath);
    if (!beforeRaw) {
      return cors(
        json({ error: "Snapshot not found in storage" }, { status: 404 }),
      );
    }
    const before = JSON.parse(beforeRaw);
    const productId =
      (before.admin_graphql_api_id as string) || change.resourceId;

    try {
      // Variant subfield: token is "variant:<subfield>:<gid>".
      if (field.startsWith("variant:")) {
        const rest = field.slice("variant:".length);
        const sep = rest.indexOf(":");
        const sub = rest.slice(0, sep);
        const variantGid = rest.slice(sep + 1);
        const variant = ((before.variants ?? []) as Array<
          Record<string, unknown>
        >).find((v) => v.admin_graphql_api_id === variantGid);
        if (!variant) {
          return cors(
            json({ error: "Variant not found in snapshot" }, { status: 404 }),
          );
        }
        if (!Object.prototype.hasOwnProperty.call(variant, sub)) {
          return cors(
            json(
              { error: "Field not captured in this snapshot" },
              { status: 422 },
            ),
          );
        }
        const variantInput: Record<string, unknown> = { id: variantGid };
        if (sub === "sku") {
          variantInput.inventoryItem = { sku: variant.sku }; // needs write_inventory
        } else if (sub === "cost") {
          variantInput.inventoryItem = { cost: variant.cost }; // InventoryItemInput.cost
        } else if (sub === "compare_at_price") {
          variantInput.compareAtPrice = variant.compare_at_price; // REST→GraphQL rename
        } else {
          variantInput[sub] = variant[sub]; // price, barcode (REST string passes through)
        }
        const result = await (
          await admin.graphql(VARIANTS_BULK_UPDATE_MUTATION, {
            variables: { productId, variants: [variantInput] },
          })
        ).json();
        const errs = [
          ...((result.data?.productVariantsBulkUpdate?.userErrors ??
            []) as Array<{ message: string }>),
          ...((result as { errors?: Array<{ message: string }> }).errors ?? []),
        ].map((e) => e.message);
        if (errs.length) return cors(json({ error: errs.join(", ") }, { status: 500 }));
        suppressNextWebhook(productId);
        markUndone(changeId, field);
        return cors(json({ success: true }));
      }

      // Product scalar: translate the REST key/value to the GraphQL input.
      if (!Object.prototype.hasOwnProperty.call(before, field)) {
        return cors(
          json({ error: "Field not captured in this snapshot" }, { status: 422 }),
        );
      }
      const productInput: Record<string, unknown> = { id: productId };
      switch (field) {
        case "title":
          productInput.title = before.title;
          break;
        case "body_html":
          productInput.descriptionHtml = before.body_html ?? "";
          break;
        case "vendor":
          productInput.vendor = before.vendor;
          break;
        case "product_type":
          productInput.productType = before.product_type;
          break;
        case "handle":
          productInput.handle = before.handle;
          break;
        case "tags":
          productInput.tags = String(before.tags ?? "")
            .split(/,\s*/)
            .map((t) => t.trim())
            .filter(Boolean);
          break;
        case "status":
          productInput.status = String(before.status ?? "").toUpperCase();
          break;
        case "category": {
          // ProductUpdateInput.category takes the taxonomy gid; ".../na" = clear.
          const id = (
            before.category as { admin_graphql_api_id?: string } | null
          )?.admin_graphql_api_id;
          productInput.category = id && !id.endsWith("/na") ? id : null;
          break;
        }
        default:
          return cors(
            json({ error: "Field not revertable per-edit" }, { status: 400 }),
          );
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
      suppressNextWebhook(productId);
      markUndone(changeId, field);
      return cors(json({ success: true }));
    } catch (error) {
      return cors(
        json(
          { error: error instanceof Error ? error.message : "Revert failed" },
          { status: 500 },
        ),
      );
    }
  }

  // Path 2 — revert a single change to the BACKUP value (per-change diff).
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

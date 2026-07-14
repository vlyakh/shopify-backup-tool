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
  suppressNextWebhook,
  suppressWebhooksFor,
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

const PUBLICATIONS_QUERY = `#graphql
  query { publications(first: 25) { nodes { id name } } }
`;

const PUBLISH_MUTATION = `#graphql
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const UNPUBLISH_MUTATION = `#graphql
  mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
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

// REST weight_unit → GraphQL WeightUnit (for inventoryItem.measurement.weight).
const WEIGHT_UNITS: Record<string, string> = {
  g: "GRAMS",
  kg: "KILOGRAMS",
  oz: "OUNCES",
  lb: "POUNDS",
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

    // True while a burst window is armed AHEAD of a write that hasn't
    // succeeded yet. The error paths below must disarm it — a failed revert
    // produces no echo, and a leftover window would hide (hidden=true) real
    // merchant edits made in its remaining ~10s.
    let preArmedWindow = false;
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
        // Weight is stored as weight_value/weight_unit (no "weight" key), so the
        // presence check must look at the field that actually holds the value.
        const presenceKey = sub === "weight" ? "weight_value" : sub;
        if (!Object.prototype.hasOwnProperty.call(variant, presenceKey)) {
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
          variantInput.inventoryItem = { cost: variant.cost };
        } else if (sub === "harmonized_system_code") {
          variantInput.inventoryItem = {
            harmonizedSystemCode: variant.harmonized_system_code,
          };
        } else if (sub === "country_code_of_origin") {
          variantInput.inventoryItem = {
            countryCodeOfOrigin: variant.country_code_of_origin,
          };
        } else if (sub === "requires_shipping") {
          variantInput.inventoryItem = {
            requiresShipping: variant.requires_shipping,
          };
        } else if (sub === "inventory_management") {
          variantInput.inventoryItem = {
            tracked: variant.inventory_management === "shopify",
          };
        } else if (sub === "weight") {
          // First observation has no prior weight (null); Number(null) === 0
          // would silently zero the weight, so refuse rather than write 0.
          if (variant.weight_value == null || variant.weight_value === "") {
            return cors(
              json({ error: "No prior weight to revert to" }, { status: 422 }),
            );
          }
          variantInput.inventoryItem = {
            measurement: {
              weight: {
                value: Number(variant.weight_value),
                unit: WEIGHT_UNITS[String(variant.weight_unit)] ?? "GRAMS",
              },
            },
          };
        } else if (sub === "inventory_policy") {
          variantInput.inventoryPolicy = String(
            variant.inventory_policy ?? "deny",
          ).toUpperCase();
        } else if (sub === "compare_at_price") {
          variantInput.compareAtPrice = variant.compare_at_price; // REST→GraphQL rename
        } else {
          variantInput[sub] = variant[sub]; // price, barcode (REST string passes through)
        }
        // The INVENTORY_TRACKED subfields echo TWO webhooks: products/update
        // AND inventory_items/update — and the processor resolves the item to
        // this same product GID before consuming a mark, so a single
        // count-mark is burned by whichever echo records first and the other
        // surfaces as a visible phantom row. Use a short burst window instead
        // (same shape as the metafield undo below), opened BEFORE the write so
        // a fast delivery can't beat the arm, and refreshed after.
        const doubleEcho = [
          "cost",
          "harmonized_system_code",
          "country_code_of_origin",
          "weight",
        ].includes(sub);
        const doubleEchoAnchor = new Date();
        if (doubleEcho) {
          await suppressWebhooksFor(
            session.shop,
            productId,
            10_000,
            doubleEchoAnchor,
          );
          preArmedWindow = true;
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
        if (errs.length) {
          // The write failed → no echo is coming; disarm the pre-armed window
          // so it can't hide real merchant edits made right after the error.
          if (preArmedWindow) {
            await clearSuppressionWindow(session.shop, productId);
          }
          const msg = errs.join(", ");
          return cors(
            json(
              {
                error: /does not exist|not found/i.test(msg)
                  ? 'This variant no longer exists — the product’s variants were changed since this edit. Undo it with "Revert all to backup".'
                  : msg,
              },
              { status: 500 },
            ),
          );
        }
        preArmedWindow = false; // the write applied — its echoes ARE coming
        if (doubleEcho) {
          // Anchor keeps the pre-write armedAt even if a throttled write
          // outlasted the 10s window — echoes delivered mid-write still match.
          await suppressWebhooksFor(
            session.shop,
            productId,
            10_000,
            doubleEchoAnchor,
          );
        } else {
          await suppressNextWebhook(session.shop, productId);
        }
        await markUndone(changeId, field);
        return cors(json({ success: true }));
      }

      // Publishing (Online Store) — publish/unpublish to match the before-state.
      if (field === "published_at") {
        const shouldPublish = !!before.published_at;
        const pubs = (await (
          await admin.graphql(PUBLICATIONS_QUERY)
        ).json()) as {
          data?: {
            publications?: { nodes?: Array<{ id: string; name: string }> };
          };
        };
        const publicationId = (pubs.data?.publications?.nodes ?? []).find(
          (p) => p.name === "Online Store",
        )?.id;
        if (!publicationId) {
          return cors(
            json(
              { error: "Online Store publication not found" },
              { status: 500 },
            ),
          );
        }
        const result = (await (
          await admin.graphql(
            shouldPublish ? PUBLISH_MUTATION : UNPUBLISH_MUTATION,
            { variables: { id: productId, input: [{ publicationId }] } },
          )
        ).json()) as {
          data?: Record<string, { userErrors?: Array<{ message: string }> }>;
          errors?: Array<{ message: string }>;
        };
        const key = shouldPublish
          ? "publishablePublish"
          : "publishableUnpublish";
        const errs = [
          ...(result.data?.[key]?.userErrors ?? []),
          ...(result.errors ?? []),
        ].map((e) => e.message);
        if (errs.length) {
          return cors(json({ error: errs.join(", ") }, { status: 500 }));
        }
        await suppressNextWebhook(session.shop, productId);
        await markUndone(changeId, field);
        return cors(json({ success: true }));
      }

      // Metafield — token "metafield:<namespace>|<key>". Revert to the before
      // value, or delete it if there was no value before (it had been added).
      if (field.startsWith("metafield:")) {
        const k = field.slice("metafield:".length);
        const sep = k.indexOf("|");
        const namespace = k.slice(0, sep);
        const key = k.slice(sep + 1);
        const mf = (
          (before.metafields ?? []) as Array<Record<string, unknown>>
        ).find((m) => m.namespace === namespace && m.key === key);
        const value = mf?.value;
        type MfResult = {
          data?: Record<string, { userErrors?: Array<{ message: string }> }>;
          errors?: Array<{ message: string }>;
        };
        let result: MfResult;
        let typeMissing = false;
        if (value === null || value === undefined || value === "") {
          result = (await (
            await admin.graphql(METAFIELDS_DELETE_MUTATION, {
              variables: {
                metafields: [{ ownerId: productId, namespace, key }],
              },
            })
          ).json()) as MfResult;
        } else {
          const input: Record<string, unknown> = {
            ownerId: productId,
            namespace,
            key,
            value: String(value),
          };
          // Recreating a DELETED metafield needs `type` — metafieldsSet only
          // infers it when the metafield still exists or has a definition.
          // Newer before-blobs carry it; legacy blobs don't, so flag that and
          // let the write proceed (it still works when the metafield exists),
          // mapping a type failure below to an error that explains itself.
          if (mf?.type) input.type = String(mf.type);
          typeMissing = !input.type;
          result = (await (
            await admin.graphql(METAFIELDS_SET_MUTATION, {
              variables: { metafields: [input] },
            })
          ).json()) as MfResult;
        }
        const errs = [
          ...(result.data?.metafieldsSet?.userErrors ?? []),
          ...(result.data?.metafieldsDelete?.userErrors ?? []),
          ...(result.errors ?? []),
        ].map((e) => e.message);
        if (errs.length) {
          if (typeMissing && errs.some((m) => /type/i.test(m))) {
            return cors(
              json(
                {
                  error: `Can't undo this change: the metafield ${namespace}.${key} no longer exists on the product, and this change was recorded before its type was tracked, so it can't be recreated automatically. Re-add it manually with the value shown in the history. (Shopify: ${errs.join(", ")})`,
                },
                { status: 422 },
              ),
            );
          }
          return cors(json({ error: errs.join(", ") }, { status: 500 }));
        }
        // Suppress both the main + metafields webhooks the write triggers.
        await suppressWebhooksFor(session.shop, productId);
        await markUndone(changeId, field);
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
        case "template_suffix":
          productInput.templateSuffix = before.template_suffix ?? null;
          break;
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
      await suppressNextWebhook(session.shop, productId);
      await markUndone(changeId, field);
      return cors(json({ success: true }));
    } catch (error) {
      if (preArmedWindow) {
        // The write's outcome is unknown/failed, so no echo may ever arrive —
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
        // Media reconcile fires several webhooks → burst window, like
        // revert-all. Open it BEFORE the writes (echoes can be delivered while
        // the reconcile is still running) and LONG enough to cover the
        // media-ingestion wait inside the reconcile — with the default 10s the
        // window expires mid-poll and the products/update echo fired when the
        // media turn READY records as a visible phantom change. The refresh
        // after shortens it back to the normal ~10s tail.
        const imagesAnchor = new Date();
        await suppressWebhooksFor(
          session.shop,
          productId,
          IMAGE_RECONCILE_SUPPRESS_MS,
          imagesAnchor,
        );
        const warnings = await reconcileProductImages(
          admin,
          productId,
          data.images?.nodes ?? [],
        );
        // Anchor keeps the pre-reconcile armedAt even if the reconcile
        // outlasted its window — echoes delivered during the lapse still match.
        await suppressWebhooksFor(session.shop, productId, 10_000, imagesAnchor);
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
      await suppressNextWebhook(session.shop, productId);
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
      await suppressNextWebhook(session.shop, productId);
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

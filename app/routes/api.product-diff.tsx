import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { imageSignature } from "../services/image-signature.server";

/**
 * API endpoint for the product diff / undo UX (Undo block + Restore action).
 * Compares the live Shopify product against its latest COMPLETED backup and
 * reports whether it changed, plus a per-field summary of what changed.
 *
 * GET /api/product-diff?resourceId=gid://shopify/Product/123
 *
 * Response shape (consumed by the Undo block, the Restore action, and the dashboard):
 *   {
 *     hasBackup: boolean,        // a COMPLETED backup item with a readable blob exists
 *     changed: boolean,          // live product differs from backup on >= 1 DIFF_FIELDS key
 *     deleted?: boolean,         // present + true only when the live product no longer exists
 *     backupItemId: string|null, // BackupItem.id to POST to /api/revert-product
 *     lastBackedUp: string|null, // ISO timestamp of the backup's createdAt
 *     changedFields: Array<{ field, before, after, label, summary }>
 *                                // CURRENT snapshot delta (live vs latest backup).
 *                                // before/after: legacy stringified+truncated values (kept for compat).
 *                                // label: human field name; summary: one readable line (NOT JSON).
 *     timeline: Array<{ id, changedAt, action, fields: Array<{ field, label }> }>
 *                                // ChangeLog history, NEWEST FIRST — the source of "when".
 *                                // Empty on stores without webhooks (popups fall back to changedFields).
 *   }
 */

// Field shape MUST mirror PRODUCTS_QUERY in backup.server.ts so before/after diff is apples-to-apples.
// (This is the products(first:50){nodes{...}} selection collapsed onto product(id:$id){...}.)
const PRODUCT_DIFF_QUERY = `#graphql
  query GetProductForDiff($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      productType
      vendor
      tags
      status
      templateSuffix
      category {
        id
        name
      }
      options {
        id
        name
        position
        values
      }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          taxable
          position
          selectedOptions {
            name
            value
          }
          inventoryItem {
            id
            tracked
            requiresShipping
            measurement {
              weight {
                value
                unit
              }
            }
          }
        }
      }
      images(first: 50) {
        nodes {
          id
          url
          altText
          width
          height
        }
      }
      metafields(first: 50) {
        nodes {
          id
          namespace
          key
          value
          type
        }
      }
      seo {
        title
        description
      }
    }
  }
`;

// Top-level keys we actually back up and could revert. Diff is restricted to this
// allow-list (and deliberately excludes `id`, which is always equal) to avoid noise
// from server-only/echoed fields. Stable order so the UIs render fields consistently.
const DIFF_FIELDS = [
  "title",
  "handle",
  "descriptionHtml",
  "productType",
  "vendor",
  "tags",
  "status",
  "templateSuffix",
  "category",
  "options",
  "variants",
  "images",
  "metafields",
  "seo",
];

const TRUNCATE = 80;

/**
 * Stringify a value and truncate to <= TRUNCATE chars with a trailing ellipsis.
 */
function short(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE - 1) + "…" : s;
}

// Human-readable display label per top-level field. Used by both the snapshot
// diff and the ChangeLog timeline so the popups never render raw field keys.
const FIELD_LABELS: Record<string, string> = {
  // GraphQL keys (the snapshot-diff side, camelCase).
  title: "Title",
  handle: "Handle",
  descriptionHtml: "Description",
  productType: "Product type",
  vendor: "Vendor",
  tags: "Tags",
  status: "Status",
  templateSuffix: "Template",
  category: "Category",
  options: "Options",
  variants: "Variants",
  images: "Images",
  metafields: "Metafields",
  seo: "SEO",
  // REST/webhook keys (the ChangeLog timeline side, snake_case) — ChangeLog stores
  // the raw product webhook payload keys, which differ from the GraphQL names.
  body_html: "Description",
  product_type: "Product type",
  template_suffix: "Template",
  image: "Images",
  published_at: "Published",
};

// Webhook payload keys that bump on essentially every product update and would
// otherwise render as noise badges ("Updated_at", "Variant Gids") in the timeline.
// variant_gids/variant_ids are internal id-lists redundant with `variants`.
const TIMELINE_NOISE_KEYS = new Set([
  "updated_at",
  "created_at",
  "admin_graphql_api_id",
  "id",
  "variant_gids",
  "variant_ids",
  "published_scope",
]);

function prettyLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  // Title-case an unknown (usually snake_case) key: body_html -> "Body Html".
  const out = field
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return out || field;
}

// Count items in a connection ({ nodes: [...] }) or a plain array; null otherwise.
function nodeCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { nodes?: unknown[] }).nodes)
  ) {
    return (value as { nodes: unknown[] }).nodes.length;
  }
  return null;
}

// Deep-diff variants (matched by id) so a variant change shows the actual fields
// that changed with old → new values (e.g. "Default Title: SKU A → B") instead of
// a useless "1 variants". before = backup (old), after = live (new).
function summarizeVariants(before: unknown, after: unknown): string {
  type V = Record<string, unknown>;
  const nodesOf = (v: unknown): V[] => {
    if (Array.isArray(v)) return v as V[];
    if (
      v &&
      typeof v === "object" &&
      Array.isArray((v as { nodes?: unknown[] }).nodes)
    ) {
      return (v as { nodes: V[] }).nodes;
    }
    return [];
  };
  const fmt = (v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    const s = String(v);
    return s.length > 30 ? s.slice(0, 29) + "…" : s;
  };
  const weightOf = (v: V) =>
    (
      v.inventoryItem as
        | { measurement?: { weight?: { value?: number; unit?: string } } }
        | undefined
    )?.measurement?.weight;

  const beforeNodes = nodesOf(before);
  const afterNodes = nodesOf(after);
  const FIELDS: Array<[string, string]> = [
    ["sku", "SKU"],
    ["price", "Price"],
    ["compareAtPrice", "Compare-at"],
    ["barcode", "Barcode"],
    ["taxable", "Taxable"],
  ];

  const lines: string[] = [];
  for (const av of afterNodes) {
    const bv = beforeNodes.find((b) => b.id === av.id);
    const label = (av.title as string) || (av.sku as string) || "Variant";
    if (!bv) {
      lines.push(`${label} added`);
      continue;
    }
    const subs: string[] = [];
    for (const [key, klabel] of FIELDS) {
      if (JSON.stringify(bv[key]) !== JSON.stringify(av[key])) {
        subs.push(`${klabel} ${fmt(bv[key])} → ${fmt(av[key])}`);
      }
    }
    const bw = weightOf(bv);
    const aw = weightOf(av);
    if (JSON.stringify(bw) !== JSON.stringify(aw)) {
      const wfmt = (w?: { value?: number; unit?: string }) =>
        w && w.value != null ? `${w.value}${w.unit ? " " + w.unit : ""}` : "—";
      subs.push(`Weight ${wfmt(bw)} → ${wfmt(aw)}`);
    }
    if (subs.length) lines.push(`${label}: ${subs.join(", ")}`);
  }
  for (const bv of beforeNodes) {
    if (!afterNodes.find((a) => a.id === bv.id)) {
      lines.push(
        `${(bv.title as string) || (bv.sku as string) || "Variant"} removed`,
      );
    }
  }
  if (!lines.length) {
    return beforeNodes.length !== afterNodes.length
      ? `${beforeNodes.length} → ${afterNodes.length} variants`
      : `${afterNodes.length} variants changed`;
  }
  return lines.join("; ");
}

/**
 * Build a ONE-LINE human summary of a field change. This replaces the old
 * before/after JSON.stringify (which dumped `{"nodes":[...]}` for variants,
 * images, etc.) — never stringify a complex object into the UI.
 */
function summarizeField(field: string, before: unknown, after: unknown): string {
  switch (field) {
    case "variants":
      return summarizeVariants(before, after);
    case "images":
    case "metafields": {
      const b = nodeCount(before);
      const a = nodeCount(after);
      if (b !== null && a !== null && b !== a) {
        const delta = a - b;
        return `${b} → ${a} ${field} (${Math.abs(delta)} ${delta > 0 ? "added" : "removed"})`;
      }
      const n = a ?? b;
      return n !== null ? `${n} ${field} changed` : `${prettyLabel(field)} updated`;
    }
    case "options": {
      const opts = Array.isArray(after)
        ? (after as Array<{ name?: string; values?: unknown[] }>)
        : [];
      return opts.length
        ? opts
            .map((o) => `${o.name ?? "?"} (${o.values?.length ?? 0} values)`)
            .join(", ")
        : "Options updated";
    }
    case "tags": {
      const tags = Array.isArray(after) ? (after as string[]) : [];
      if (!tags.length) return "Tags cleared";
      const head = tags.slice(0, 3).join(", ");
      return `Tags: ${head}${tags.length > 3 ? ` (+${tags.length - 3} more)` : ""}`;
    }
    case "category": {
      const b = (before as { name?: string } | null)?.name;
      const a = (after as { name?: string } | null)?.name;
      if (b || a) return `${b ?? "—"} → ${a ?? "—"}`;
      return "Category updated";
    }
    case "seo":
      return "SEO updated";
    case "descriptionHtml": {
      // Strip tags + collapse whitespace so the text change is readable.
      const strip = (v: unknown) =>
        String(v ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const clip = (s: string) =>
        s === "" ? "—" : s.length > 40 ? s.slice(0, 39) + "…" : s;
      return `${clip(strip(before))} → ${clip(strip(after))}`;
    }
    default: {
      // Scalar fields (title, handle, vendor, productType, status, templateSuffix).
      const clip = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
      const fmt = (v: unknown) =>
        v === null || v === undefined || v === "" ? "—" : clip(String(v));
      return `${fmt(before)} → ${fmt(after)}`;
    }
  }
}

// A single, independently-revertable change (backup → live) for the per-change
// Undo UX. `target` tells /api/revert-product-field exactly what to revert.
type Change = {
  id: string;
  label: string;
  before: string;
  after: string;
  target:
    | { kind: "product"; field: string }
    | { kind: "variant"; variantId: string; field: string };
};

// The "Uncategorized" placeholder (id ".../na") and a missing category both mean
// "no category" — normalize so they compare equal (avoids a false category diff).
function normCategoryId(c: unknown): string | null {
  const id = (c as { id?: string } | null)?.id;
  return !id || id.endsWith("/na") ? null : id;
}

function shortValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function variantNodes(v: unknown): Array<Record<string, unknown>> {
  if (
    v &&
    typeof v === "object" &&
    Array.isArray((v as { nodes?: unknown[] }).nodes)
  ) {
    return (v as { nodes: Array<Record<string, unknown>> }).nodes;
  }
  return [];
}

/**
 * Flatten the backup→live diff into a list of granular, independently-revertable
 * changes: each product field, each changed variant subfield (price/sku/…), and
 * images. This drives the per-change Undo UI (revert one, keep the rest).
 */
function buildChanges(
  backup: Record<string, unknown>,
  live: Record<string, unknown>,
): Change[] {
  const changes: Change[] = [];
  const push = (
    id: string,
    label: string,
    before: unknown,
    after: unknown,
    target: Change["target"],
  ) =>
    changes.push({
      id,
      label,
      before: shortValue(before),
      after: shortValue(after),
      target,
    });

  const SCALARS: Array<[string, string]> = [
    ["title", "Title"],
    ["handle", "Handle"],
    ["productType", "Product type"],
    ["vendor", "Vendor"],
    ["status", "Status"],
    ["templateSuffix", "Template"],
  ];
  for (const [field, label] of SCALARS) {
    if (JSON.stringify(backup[field]) !== JSON.stringify(live[field])) {
      push(field, label, backup[field], live[field], { kind: "product", field });
    }
  }

  if (
    JSON.stringify(backup.descriptionHtml) !==
    JSON.stringify(live.descriptionHtml)
  ) {
    const strip = (v: unknown) =>
      String(v ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    push("descriptionHtml", "Description", strip(backup.descriptionHtml), strip(live.descriptionHtml), { kind: "product", field: "descriptionHtml" });
  }

  if (JSON.stringify(backup.tags) !== JSON.stringify(live.tags)) {
    const t = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(", ") : "—");
    push("tags", "Tags", t(backup.tags), t(live.tags), { kind: "product", field: "tags" });
  }

  if (normCategoryId(backup.category) !== normCategoryId(live.category)) {
    const name = (c: unknown) => (c as { name?: string } | null)?.name || "—";
    push("category", "Category", name(backup.category), name(live.category), { kind: "product", field: "category" });
  }

  if (JSON.stringify(backup.seo) !== JSON.stringify(live.seo)) {
    push("seo", "SEO", (backup.seo as { title?: string } | null)?.title, (live.seo as { title?: string } | null)?.title, { kind: "product", field: "seo" });
  }

  // Variants → one change per changed subfield. Single-variant products drop the
  // "· Default Title" suffix so a price change reads simply as "Price".
  const bVars = variantNodes(backup.variants);
  const lVars = variantNodes(live.variants);
  const multi = bVars.length > 1 || lVars.length > 1;
  const VFIELDS: Array<[string, string]> = [
    ["price", "Price"],
    ["compareAtPrice", "Compare-at price"],
    ["sku", "SKU"],
    ["barcode", "Barcode"],
    ["taxable", "Taxable"],
  ];
  // Identify a variant by its option(s) WITH the option name ("Denomination: $10")
  // so a value like "$10" isn't mistaken for a price. Falls back to the variant
  // title, then "variant".
  const variantDesc = (v: Record<string, unknown>): string => {
    const opts = v.selectedOptions;
    if (Array.isArray(opts) && opts.length) {
      return (opts as Array<{ name?: string; value?: string }>)
        .map((o) => `${o.name}: ${o.value}`)
        .join(", ");
    }
    return (v.title as string) || "variant";
  };
  for (const lv of lVars) {
    const bv = bVars.find((b) => b.id === lv.id);
    if (!bv) continue; // added variant — structural, not a field-level revert
    const suffix = multi ? ` · ${variantDesc(lv)}` : "";
    for (const [field, flabel] of VFIELDS) {
      if (JSON.stringify(bv[field]) !== JSON.stringify(lv[field])) {
        push(
          `variant:${lv.id}:${field}`,
          `${flabel}${suffix}`,
          bv[field],
          lv[field],
          { kind: "variant", variantId: lv.id as string, field },
        );
      }
    }
  }

  if (imageSignature(backup.images) !== imageSignature(live.images)) {
    push("images", "Images", `${variantNodes(backup.images).length} images`, `${variantNodes(live.images).length} images`, { kind: "product", field: "images" });
  }

  return changes;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId");

  if (!resourceId) {
    return cors(json({ error: "resourceId required" }, { status: 400 }));
  }

  try {
    // Find the most recent COMPLETED backup item for this resource
    const latestBackupItem = await prisma.backupItem.findFirst({
      where: {
        resourceId,
        resourceType: "PRODUCT",
        backup: { storeId: session.shop, status: "COMPLETED" },
      },
      orderBy: { backup: { createdAt: "desc" } },
      include: { backup: { select: { createdAt: true } } },
    });

    // No-backup short-circuit
    if (!latestBackupItem) {
      return cors(
        json({
          hasBackup: false,
          changed: false,
          backupItemId: null,
          lastBackedUp: null,
          changedFields: [],
          timeline: [],
        }),
      );
    }

    // The change ledger: webhook-recorded changes to this product SINCE its latest
    // backup, newest first. A fresh backup is the new baseline, so it resets the
    // ledger (changes before the backup are baked into it). Empty on stores without
    // webhooks (ChangeLog isn't written then) — the popups then fall back to the
    // snapshot diff. changedFields here are top-level NAMES (a variant edit shows
    // as "variants"); noise keys (updated_at, variant_gids…) are filtered out.
    const history = await prisma.changeLog.findMany({
      where: {
        storeId: session.shop,
        resourceType: "PRODUCT",
        resourceId,
        changedAt: { gt: latestBackupItem.backup.createdAt },
      },
      orderBy: { changedAt: "desc" },
      take: 50,
    });
    const timeline = history
      .map((row) => ({
        id: row.id,
        changedAt: row.changedAt.toISOString(),
        action: row.action,
        fields: (row.changedFields ?? [])
          .filter((f) => !TIMELINE_NOISE_KEYS.has(f))
          .map((f) => ({ field: f, label: prettyLabel(f) })),
      }))
      .filter((ev) => ev.action !== "UPDATED" || ev.fields.length > 0);

    // Load the backed-up product JSON from storage. Degrade gracefully (read-only
    // status probe) to a no-backup response if the blob is missing/unreadable.
    const raw = await storage.get(latestBackupItem.storagePath);
    if (!raw) {
      return cors(
        json({
          hasBackup: false,
          changed: false,
          backupItemId: null,
          lastBackedUp: null,
          changedFields: [],
          timeline,
        }),
      );
    }

    const backupData = JSON.parse(raw) as Record<string, unknown>;

    // Fetch the current product from Shopify with the SAME field shape as PRODUCTS_QUERY.
    const resp = await admin.graphql(PRODUCT_DIFF_QUERY, {
      variables: { id: resourceId },
    });
    const result = await resp.json();
    const liveProduct = result.data?.product as Record<string, unknown> | null;

    // Product was deleted — nothing to "undo" via the revert flow. Recovering a
    // deleted product is the job of restore-product / recover-deleted-action.
    if (!liveProduct) {
      return cors(
        json({
          hasBackup: true,
          changed: false,
          deleted: true,
          backupItemId: latestBackupItem.id,
          lastBackedUp: latestBackupItem.backup.createdAt.toISOString(),
          changedFields: [],
          timeline,
        }),
      );
    }

    // Compute changed top-level fields (shallow stringify compare per DIFF_FIELDS key).
    // Caveat: `tags` may come back in a different array order between backup and live,
    // so this compare can flag it as changed even when the set is equal. Acceptable for
    // v1 — computeChangedFields in changelog.server.ts has the same limitation.
    const changedFields: Array<{
      field: string;
      before: string;
      after: string;
      label: string;
      summary: string;
    }> = [];
    for (const field of DIFF_FIELDS) {
      const before = backupData[field];
      const after = liveProduct[field];
      // `images` is compared by a stable signature (filename + altText), NOT raw
      // JSON: restoring images re-ingests them under new urls/ids, so a raw
      // compare would report a just-reverted product as changed forever.
      const differs =
        field === "images"
          ? imageSignature(before) !== imageSignature(after)
          : JSON.stringify(before) !== JSON.stringify(after);
      if (differs) {
        changedFields.push({
          field,
          before: short(before),
          after: short(after),
          label: prettyLabel(field),
          summary: summarizeField(field, before, after),
        });
      }
    }
    // Granular, independently-revertable changes (drives the per-change Undo UI).
    // `changed` is derived from these, so the false-positive category case (a
    // missing category vs the "Uncategorized" sentinel) no longer shows the block.
    const changes = buildChanges(backupData, liveProduct);
    const changed = changes.length > 0;

    return cors(
      json({
        hasBackup: true,
        changed,
        backupItemId: latestBackupItem.id,
        lastBackedUp: latestBackupItem.backup.createdAt.toISOString(),
        changedFields,
        changes,
        timeline,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error: error instanceof Error ? error.message : "Product diff failed",
        },
        { status: 500 },
      ),
    );
  }
};

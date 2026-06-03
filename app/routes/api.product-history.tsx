import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { isUndone, isHidden } from "../services/revert-bookkeeping.server";
import {
  graphqlBackupToRest,
  firstEventChangedFields,
} from "../services/changelog.server";

/**
 * Change history (audit ledger) for a product's Undo popup. Returns each webhook
 * edit SINCE the latest backup as its own row — timestamp + field + before → after
 * — expanded so a single event that touched several fields (or several variant
 * subfields) yields multiple rows, and the same field edited twice yields two rows.
 *
 * Values come from the ChangeLog before/after snapshot blobs, which are the raw
 * REST products/update webhook payloads (snake_case; tags comma-string; variants
 * REST-shaped). `field` is an opaque token echoed back to /api/revert-product-field
 * to undo just that edit (set the field to that row's BEFORE value).
 *
 * GET /api/product-history?resourceId=gid://shopify/Product/123
 *   → { hasBackup, lastBackedUp, rows: [{ changeId, changedAt, field, label,
 *       before, after, revertable }] }  (newest first; rows:[] without webhooks)
 */

// Top-level REST keys that bump on edits but aren't user-facing changes.
const NOISE_KEYS = new Set([
  "id",
  "admin_graphql_api_id",
  "created_at",
  "updated_at",
  // published_at is handled (Online Store publish/unpublish), not noise.
  "published_scope",
  "variant_ids",
  "variant_gids",
  "image",
  "image_id",
]);

const SCALAR_LABELS: Record<string, string> = {
  title: "Title",
  body_html: "Description",
  vendor: "Vendor",
  product_type: "Product type",
  handle: "Handle",
  tags: "Tags",
  status: "Status",
  template_suffix: "Theme template",
};

// Revertable variant subfields (REST key → label). Weight is handled separately
// (it needs the unit). cost/HS/origin arrive via inventory_items/update.
const VARIANT_FIELDS: Array<[string, string]> = [
  ["price", "Price"],
  ["compare_at_price", "Compare-at price"],
  ["barcode", "Barcode"],
  ["sku", "SKU"],
  ["taxable", "Charge tax"],
  ["cost", "Cost per item"],
  ["requires_shipping", "Requires shipping"],
  ["inventory_policy", "Continue selling when out of stock"],
  ["inventory_management", "Track quantity"],
  ["harmonized_system_code", "HS code"],
  ["country_code_of_origin", "Country of origin"],
];

// Friendly display for variant subfield values (booleans/enums → words).
function fmtVariantValue(sub: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (sub) {
    case "taxable":
    case "requires_shipping":
      return value ? "Yes" : "No";
    case "inventory_management":
      return value === "shopify" ? "Tracked" : "Not tracked";
    case "inventory_policy":
      return value === "continue" ? "Continue selling" : "Stop selling";
    default:
      return clip(value);
  }
}

function clip(v: unknown, n = 48): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function tagsArr(v: unknown): string[] {
  return String(v ?? "")
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function fmtScalar(field: string, value: unknown): string {
  if (field === "body_html") {
    return clip(
      String(value ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  if (field === "tags") {
    const a = tagsArr(value);
    return a.length
      ? `${a.slice(0, 3).join(", ")}${a.length > 3 ? ` +${a.length - 3}` : ""}`
      : "—";
  }
  return clip(value);
}

// The webhook category is { admin_graphql_api_id, id, name, full_name } | null.
function catName(c: unknown): string {
  const name = (c as { name?: string } | null)?.name;
  return name ? clip(name) : "—";
}

type RestVariant = Record<string, unknown> & { admin_graphql_api_id?: string };

function variantDesc(v: RestVariant): string {
  const opts = [v.option1, v.option2, v.option3].filter(Boolean) as string[];
  return opts.join(" / ") || (v.title as string) || "Variant";
}

type Row = {
  changeId: string;
  changedAt: string;
  field: string;
  label: string;
  before: string;
  after: string;
  revertable: boolean;
};

// Classify a change so the popup can show the action (Added/Removed) as its own
// badge, instead of "Added <value>" reading as one phrase.
function classifyChange(
  before: string,
  after: string,
): { change: "added" | "removed" | "changed"; text: string } {
  if (before === "—" && after !== "—") return { change: "added", text: after };
  if (before !== "—" && after === "—")
    return { change: "removed", text: before };
  return { change: "changed", text: `${before} → ${after}` };
}

/**
 * Collapse consecutive edits to the SAME field into one net change, so rapid
 * flip-flopping (Shopify fires a webhook per keystroke/save) reads as a single
 * "— → 56" instead of three toggling rows. Rows are newest-first, so when a run
 * shares a field we pull the "before" back to the oldest edit and target the
 * oldest event for revert (so Undo restores the net-before value). Net-unchanged
 * runs (toggled back to the same value) drop out entirely.
 */
function collapseRows(rows: Row[]): Row[] {
  const out: Array<Row & { merged?: boolean }> = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.field === row.field) {
      prev.before = row.before; // older edit's before becomes the net before
      prev.changeId = row.changeId; // revert to the oldest edit's before-value
      prev.merged = true;
    } else {
      out.push({ ...row });
    }
  }
  // Only drop a MERGED run that netted back to no change (A→B→A). A single edit
  // is always a real change (the field was in changedFields) — never drop it just
  // because its clipped display happens to match.
  return out.filter((r) => !r.merged || r.before !== r.after);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resourceId");

  if (!resourceId) {
    return cors(json({ error: "resourceId required" }, { status: 400 }));
  }

  try {
    // Baseline = the latest COMPLETED backup; the ledger resets at each backup.
    const latestBackupItem = await prisma.backupItem.findFirst({
      where: {
        resourceId,
        resourceType: "PRODUCT",
        backup: { storeId: session.shop, status: "COMPLETED" },
      },
      orderBy: { backup: { createdAt: "desc" } },
      include: { backup: { select: { createdAt: true } } },
    });

    if (!latestBackupItem) {
      return cors(
        json({
          hasBackup: false,
          backupItemId: null,
          lastBackedUp: null,
          rows: [],
        }),
      );
    }

    // Recent edits, newest first — NOT limited to "since the last backup", so the
    // merchant can peel back edits from before it too. Bounded by count (last 50);
    // events undone or reverted-to-backup are filtered below. "Revert all to
    // backup" hides everything newer than the latest backup (see api.revert-product).
    const events = await prisma.changeLog.findMany({
      where: {
        storeId: session.shop,
        resourceType: "PRODUCT",
        resourceId,
        action: "UPDATED",
      },
      orderBy: { changedAt: "desc" },
      take: 50,
    });

    // Cache parsed blobs by path — consecutive events share snapshots
    // (a row's beforePath == the prior row's afterPath).
    const blobCache = new Map<string, Record<string, unknown> | null>();
    const readBlob = async (
      path: string | null,
    ): Promise<Record<string, unknown> | null> => {
      if (!path) return null;
      if (blobCache.has(path)) return blobCache.get(path) ?? null;
      let parsed: Record<string, unknown> | null = null;
      try {
        const raw = await storage.get(path);
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      blobCache.set(path, parsed);
      return parsed;
    };

    const rows: Row[] = [];
    for (const event of events) {
      if (isHidden(event.id)) continue; // our own revert/undo event — don't show
      let before = await readBlob(event.beforePath);
      const after = await readBlob(event.afterPath);
      if (!after) continue; // can't show a change without the after-state
      const changedAt = event.changedAt.toISOString();

      // First edit recorded with no baseline (the backup wasn't ready yet) →
      // diff against the backup now so the edit isn't lost.
      let fields = event.changedFields ?? [];
      if (fields.length === 0 && !event.beforePath) {
        const backupBlob = await readBlob(latestBackupItem.storagePath);
        if (backupBlob) {
          before = graphqlBackupToRest(backupBlob);
          fields = firstEventChangedFields(before, after);
        }
      }

      for (const field of fields) {
        if (NOISE_KEYS.has(field)) continue;

        if (field in SCALAR_LABELS) {
          if (isUndone(event.id, field)) continue; // already undone → hide
          rows.push({
            changeId: event.id,
            changedAt,
            field,
            label: SCALAR_LABELS[field],
            before: fmtScalar(field, before?.[field]),
            after: fmtScalar(field, after[field]),
            revertable: true,
          });
        } else if (field === "category") {
          // null / the ".../na" sentinel / "Uncategorized" all mean "no category"
          // — don't report a change between any of them.
          const catId = (c: unknown) => {
            const id =
              (c as { admin_graphql_api_id?: string; id?: string } | null)
                ?.admin_graphql_api_id ??
              (c as { id?: string } | null)?.id;
            return !id || String(id).endsWith("/na") ? "" : String(id);
          };
          if (catId(before?.category) === catId(after.category)) continue;
          if (isUndone(event.id, field)) continue; // already undone → hide
          rows.push({
            changeId: event.id,
            changedAt,
            field,
            label: "Category",
            before: catName(before?.category),
            after: catName(after.category),
            revertable: true,
          });
        } else if (field === "published_at") {
          // Online Store publish/unpublish — timestamp set vs null. Reverts via
          // publishablePublish/Unpublish (needs write_publications).
          const wasPublished = !!before?.published_at;
          const isPublished = !!after.published_at;
          if (
            before &&
            "published_at" in before &&
            wasPublished !== isPublished &&
            !isUndone(event.id, field)
          ) {
            rows.push({
              changeId: event.id,
              changedAt,
              field,
              label: "Publishing",
              before: wasPublished ? "Online Store" : "—",
              after: isPublished ? "Online Store" : "—",
              revertable: true,
            });
          }
        } else if (field === "metafields") {
          // Minimal blob: { metafields: [{ namespace, key, value, type? }] }.
          const bMf =
            (before?.metafields as Array<Record<string, unknown>>) ?? [];
          const aMf = (after.metafields as Array<Record<string, unknown>>) ?? [];
          const mfKey = (m: Record<string, unknown>) =>
            `${m.namespace}|${m.key}`;
          for (const k of new Set([...bMf, ...aMf].map(mfKey))) {
            const bv = bMf.find((m) => mfKey(m) === k)?.value ?? null;
            const av = aMf.find((m) => mfKey(m) === k)?.value ?? null;
            if (String(bv ?? "") === String(av ?? "")) continue;
            const token = `metafield:${k}`;
            if (isUndone(event.id, token)) continue;
            rows.push({
              changeId: event.id,
              changedAt,
              field: token,
              label: `Metafield: ${k.split("|")[1] ?? k}`,
              before: clip(bv),
              after: clip(av),
              revertable: true,
            });
          }
        } else if (field === "variants") {
          const bVars = (before?.variants as RestVariant[]) ?? [];
          const aVars = (after.variants as RestVariant[]) ?? [];
          const multi = bVars.length > 1 || aVars.length > 1;
          for (const av of aVars) {
            const bv = bVars.find(
              (v) => v.admin_graphql_api_id === av.admin_graphql_api_id,
            );
            if (!bv) {
              // Added variant — show it (structural; undo via "Revert all to backup").
              // Skip "Default Title" — that's Shopify's single-variant placeholder,
              // not a real variant the merchant added.
              const desc = variantDesc(av);
              if (desc !== "Default Title") {
                const parts: string[] = [];
                if (desc !== "Variant") parts.push(desc);
                if (av.price != null && av.price !== "")
                  parts.push(`$${av.price}`);
                rows.push({
                  changeId: event.id,
                  changedAt,
                  field: `variant-add:${av.admin_graphql_api_id}`,
                  label: "Variant added",
                  before: "—",
                  after: parts.join(" · "),
                  revertable: false,
                });
              }
              continue;
            }
            const suffix = multi ? ` · ${variantDesc(av)}` : "";
            for (const [sub, slabel] of VARIANT_FIELDS) {
              // Field absent from the BEFORE snapshot (e.g. the backup baseline
              // doesn't carry taxable / inventory_policy) → not a real change.
              if (bv[sub] === undefined) continue;
              if (String(bv[sub] ?? "") !== String(av[sub] ?? "")) {
                // token = variant:<subfield>:<gid>; subfield first so the gid
                // (which itself contains ":") is the clean remainder on parse.
                const token = `variant:${sub}:${av.admin_graphql_api_id}`;
                if (isUndone(event.id, token)) continue; // already undone → hide
                rows.push({
                  changeId: event.id,
                  changedAt,
                  field: token,
                  label: `${slabel}${suffix}`,
                  before: fmtVariantValue(sub, bv[sub]),
                  after: fmtVariantValue(sub, av[sub]),
                  revertable: true,
                });
              }
            }
            // Weight (grams in the payload; show in the merchant's unit).
            if (
              bv.grams !== undefined &&
              String(bv.grams ?? "") !== String(av.grams ?? "")
            ) {
              const token = `variant:weight:${av.admin_graphql_api_id}`;
              if (!isUndone(event.id, token)) {
                const wfmt = (v: RestVariant) =>
                  v.weight !== null && v.weight !== undefined && v.weight !== ""
                    ? `${v.weight} ${(v.weight_unit as string) ?? ""}`.trim()
                    : "—";
                rows.push({
                  changeId: event.id,
                  changedAt,
                  field: token,
                  label: `Weight${suffix}`,
                  before: wfmt(bv),
                  after: wfmt(av),
                  revertable: true,
                });
              }
            }
          }
          // Removed variants — present in the before snapshot, gone from after.
          for (const bv of bVars) {
            const stillThere = aVars.some(
              (v) => v.admin_graphql_api_id === bv.admin_graphql_api_id,
            );
            const desc = variantDesc(bv);
            if (!stillThere && desc !== "Default Title") {
              rows.push({
                changeId: event.id,
                changedAt,
                field: `variant-remove:${bv.admin_graphql_api_id}`,
                label: "Variant removed",
                before: desc === "Variant" ? "" : desc,
                after: "—",
                revertable: false,
              });
            }
          }
        } else if (field === "images" || field === "options") {
          // Shown for visibility but not per-edit revertable (image ids are
          // reassigned on re-ingestion; options restructure variants).
          const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
          const b = count(before?.[field]);
          const a = count(after[field]);
          if (b === a) continue; // count unchanged → noise (the real change shows elsewhere)
          rows.push({
            changeId: event.id,
            changedAt,
            field,
            label: field === "images" ? "Images" : "Options",
            before: `${b} ${field}`,
            after: `${a} ${field}`,
            revertable: false,
          });
        }
      }
    }

    const collapsed = collapseRows(rows).map((r) => {
      // Special-cased rows say the action in their label already → no action badge.
      const classified =
        r.field === "published_at"
          ? {
              change: "changed" as const,
              text:
                r.after !== "—"
                  ? "Published to Online Store"
                  : "Unpublished from Online Store",
            }
          : r.field.startsWith("variant-add:")
            ? { change: "changed" as const, text: r.after }
            : r.field.startsWith("variant-remove:")
              ? { change: "changed" as const, text: r.before }
              : classifyChange(r.before, r.after);
      return {
        changeId: r.changeId,
        changedAt: r.changedAt,
        field: r.field,
        label: r.label,
        change: classified.change,
        text: classified.text,
        revertable: r.revertable,
      };
    });

    return cors(
      json({
        hasBackup: true,
        backupItemId: latestBackupItem.id,
        lastBackedUp: latestBackupItem.backup.createdAt.toISOString(),
        rows: collapsed,
      }),
    );
  } catch (error) {
    return cors(
      json(
        { error: error instanceof Error ? error.message : "History failed" },
        { status: 500 },
      ),
    );
  }
};

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { isUndone, isHidden } from "../services/revert-bookkeeping.server";

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
  "published_at",
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
};

// Revertable variant subfields (REST key → label).
const VARIANT_FIELDS: Array<[string, string]> = [
  ["price", "Price"],
  ["compare_at_price", "Compare-at price"],
  ["barcode", "Barcode"],
  ["sku", "SKU"],
];

function clip(v: unknown, n = 28): string {
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

// Friendlier than "— → value" / "value → —".
function changeText(before: string, after: string): string {
  if (before === "—" && after !== "—") return `Added ${after}`;
  if (before !== "—" && after === "—") return `Removed ${before}`;
  return `${before} → ${after}`;
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
  const out: Row[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.field === row.field) {
      prev.before = row.before; // older edit's before becomes the net before
      prev.changeId = row.changeId; // revert to the oldest edit's before-value
    } else {
      out.push({ ...row });
    }
  }
  return out.filter((r) => r.before !== r.after);
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
      const before = await readBlob(event.beforePath);
      const after = await readBlob(event.afterPath);
      if (!after) continue; // can't show a change without the after-state
      const changedAt = event.changedAt.toISOString();

      for (const field of event.changedFields ?? []) {
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
        } else if (field === "variants") {
          const bVars = (before?.variants as RestVariant[]) ?? [];
          const aVars = (after.variants as RestVariant[]) ?? [];
          const multi = bVars.length > 1 || aVars.length > 1;
          for (const av of aVars) {
            const bv = bVars.find(
              (v) => v.admin_graphql_api_id === av.admin_graphql_api_id,
            );
            if (!bv) continue; // added variant — structural, not a field revert
            const suffix = multi ? ` · ${variantDesc(av)}` : "";
            for (const [sub, slabel] of VARIANT_FIELDS) {
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
                  before: clip(bv[sub]),
                  after: clip(av[sub]),
                  revertable: true,
                });
              }
            }
          }
        } else if (field === "images" || field === "options") {
          // Shown for visibility but not per-edit revertable (image ids are
          // reassigned on re-ingestion; options restructure variants).
          const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
          rows.push({
            changeId: event.id,
            changedAt,
            field,
            label: field === "images" ? "Images" : "Options",
            before: `${count(before?.[field])} ${field}`,
            after: `${count(after[field])} ${field}`,
            revertable: false,
          });
        }
      }
    }

    const collapsed = collapseRows(rows).map((r) => ({
      changeId: r.changeId,
      changedAt: r.changedAt,
      field: r.field,
      label: r.label,
      text: changeText(r.before, r.after),
      revertable: r.revertable,
    }));

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

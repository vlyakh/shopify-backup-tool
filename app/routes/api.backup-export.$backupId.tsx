import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

/**
 * Download a backup's products as CSV (opens in Excel). One row per variant.
 * GET /api/backup-export/:backupId  → text/csv attachment.
 * Fetched client-side (App Bridge attaches the session token) and saved via a blob.
 */
function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // OWASP CSV-injection guard: a leading =, +, -, @, tab or CR makes Excel
  // evaluate the cell as a formula; a single-quote prefix forces text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function productRows(
  title: string | null,
  p: Record<string, unknown> | null,
): string[] {
  if (!p) return [[cell(title), ...Array(10).fill(cell(""))].join(",")];
  const tags = Array.isArray(p.tags)
    ? (p.tags as string[]).join(", ")
    : ((p.tags as string) ?? "");
  const base = [p.title, p.handle, p.status, p.vendor, p.productType, tags];
  const variants =
    (p.variants as { nodes?: Array<Record<string, unknown>> } | undefined)
      ?.nodes ?? [];
  if (variants.length === 0) {
    return [[...base, "", "", "", "", ""].map(cell).join(",")];
  }
  return variants.map((v) =>
    [...base, v.title, v.sku, v.price, v.compareAtPrice, v.barcode]
      .map(cell)
      .join(","),
  );
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const backupId = params.backupId as string;

  const backup = await prisma.backup.findFirst({
    where: { id: backupId, storeId: session.shop },
  });
  if (!backup) throw new Response("Backup not found", { status: 404 });
  if (backup.status !== "COMPLETED") {
    throw new Response("Backup is not completed", { status: 409 });
  }

  const items = await prisma.backupItem.findMany({
    where: { backupId, resourceType: "PRODUCT" },
    select: { storagePath: true, title: true },
    orderBy: { resourceId: "asc" },
  });

  const headers = [
    "Product",
    "Handle",
    "Status",
    "Vendor",
    "Type",
    "Tags",
    "Variant",
    "SKU",
    "Price",
    "Compare at price",
    "Barcode",
  ];
  const lines: string[] = [headers.map(cell).join(",")];

  // Fetch blobs with a small worker pool instead of sequential awaits so
  // large stores finish before proxy idle timeouts; only the emitted CSV
  // rows are retained (per-item slots keep the output order deterministic).
  const CONCURRENCY = 8;
  const rowsByItem: string[][] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      let p: Record<string, unknown> | null = null;
      try {
        const raw = await storage.get(item.storagePath);
        p = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        p = null;
      }
      rowsByItem[i] = productRows(item.title, p);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
  );
  for (const rows of rowsByItem) lines.push(...rows);

  // BOM so Excel reads UTF-8 correctly.
  const csv = "﻿" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="backup-${backupId}.csv"`,
    },
  });
};

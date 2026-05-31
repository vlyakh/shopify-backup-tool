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
  return `"${s.replace(/"/g, '""')}"`;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const backupId = params.backupId as string;

  const backup = await prisma.backup.findFirst({
    where: { id: backupId, storeId: session.shop },
  });
  if (!backup) throw new Response("Backup not found", { status: 404 });

  const items = await prisma.backupItem.findMany({
    where: { backupId, resourceType: "PRODUCT" },
    select: { storagePath: true, title: true },
    take: 2000,
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

  for (const item of items) {
    let p: Record<string, unknown> | null = null;
    try {
      const raw = await storage.get(item.storagePath);
      p = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      p = null;
    }
    if (!p) {
      lines.push([cell(item.title), ...Array(10).fill(cell(""))].join(","));
      continue;
    }
    const tags = Array.isArray(p.tags)
      ? (p.tags as string[]).join(", ")
      : ((p.tags as string) ?? "");
    const base = [p.title, p.handle, p.status, p.vendor, p.productType, tags];
    const variants =
      (p.variants as { nodes?: Array<Record<string, unknown>> } | undefined)
        ?.nodes ?? [];
    if (variants.length === 0) {
      lines.push([...base, "", "", "", "", ""].map(cell).join(","));
    } else {
      for (const v of variants) {
        lines.push(
          [
            ...base,
            v.title,
            v.sku,
            v.price,
            v.compareAtPrice,
            v.barcode,
          ].map(cell).join(","),
        );
      }
    }
  }

  // BOM so Excel reads UTF-8 correctly.
  const csv = "﻿" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="backup-${backupId}.csv"`,
    },
  });
};

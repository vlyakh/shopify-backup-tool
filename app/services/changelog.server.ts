import prisma from "../db.server";
import { storage } from "./storage.server";
import type { ResourceType, ChangeAction } from "@prisma/client";

/**
 * Record a change from a webhook event.
 * Stores before/after snapshots and identifies changed fields.
 */
export async function recordChange(
  storeId: string,
  resourceType: ResourceType,
  resourceId: string,
  action: ChangeAction,
  data: unknown,
): Promise<string | null> {
  // Check if store has premium plan with webhooks enabled
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store?.webhooksEnabled) return null;

  const timestamp = Date.now();
  const afterPath = `${storeId}/changes/${resourceType}/${encodeURIComponent(resourceId)}/${timestamp}-after.json`;

  // Store the current state
  await storage.put(afterPath, JSON.stringify(data, null, 2));

  // Find the previous state (from last backup or last change)
  let beforePath: string | null = null;
  const changedFields: string[] = [];

  if (action === "UPDATED") {
    // Look for the most recent FULL snapshot of this resource. Skip our synthetic
    // cost/inventory/metafield events (minimal blobs) — diffing a full product
    // against one of those would flag every field as changed.
    const recent = await prisma.changeLog.findMany({
      where: { storeId, resourceType, resourceId },
      orderBy: { changedAt: "desc" },
      take: 10,
    });
    const lastChange = recent.find(
      (c) => c.afterPath && !/-(?:cost|inv|mf)-after\.json$/.test(c.afterPath),
    );

    if (lastChange?.afterPath) {
      beforePath = lastChange.afterPath;

      // Compute changed fields by comparing before/after
      const beforeData = await storage.get(beforePath);
      if (beforeData) {
        const before = JSON.parse(beforeData);
        const after = data as Record<string, unknown>;
        computeChangedFields(before, after, "", changedFields);
      }
    } else if (resourceType === "PRODUCT") {
      // First-ever tracked edit of this product: no prior snapshot to chain from,
      // so diff against the latest backup. The backup is GraphQL-shaped (camelCase);
      // convert it to the REST shape the webhook + history expect, store it as the
      // baseline `before`, and diff — otherwise the first edit is silently lost.
      const backupItem = await prisma.backupItem.findFirst({
        where: {
          resourceId,
          resourceType: "PRODUCT",
          backup: { storeId, status: "COMPLETED" },
        },
        orderBy: { backup: { createdAt: "desc" } },
      });
      const raw = backupItem ? await storage.get(backupItem.storagePath) : null;
      if (raw) {
        const restBaseline = graphqlBackupToRest(JSON.parse(raw));
        const baselinePath = `${storeId}/changes/PRODUCT/${encodeURIComponent(resourceId)}/${timestamp}-baseline.json`;
        await storage.put(baselinePath, JSON.stringify(restBaseline, null, 2));
        beforePath = baselinePath;
        changedFields.push(
          ...firstEventChangedFields(
            restBaseline,
            data as Record<string, unknown>,
          ),
        );
      }
    }
  }

  const created = await prisma.changeLog.create({
    data: {
      storeId,
      resourceType,
      resourceId,
      action,
      beforePath,
      afterPath,
      changedFields,
    },
  });
  return created.id;
}

/**
 * Shallow comparison of two objects to find changed top-level fields.
 */
function computeChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  result: string[],
): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const beforeVal = before[key];
    const afterVal = after[key];

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      result.push(fullKey);
    }
  }
}

/**
 * Convert a backed-up product (GraphQL/camelCase, as stored by backup.server.ts)
 * into the REST/snake_case shape that products/update webhook payloads use, so a
 * product's first-ever tracked edit can be diffed against the backup uniformly.
 * Only carries the fields the history + per-edit revert read.
 */
export function graphqlBackupToRest(
  g: Record<string, any>,
): Record<string, unknown> {
  const variants = ((g.variants?.nodes as Array<Record<string, any>>) ?? []).map(
    (v) => ({
      admin_graphql_api_id: v.id,
      title: v.title,
      sku: v.sku ?? null,
      price: v.price ?? null,
      compare_at_price: v.compareAtPrice ?? null,
      barcode: v.barcode ?? null,
      option1: v.selectedOptions?.[0]?.value ?? null,
      option2: v.selectedOptions?.[1]?.value ?? null,
      option3: v.selectedOptions?.[2]?.value ?? null,
    }),
  );
  return {
    admin_graphql_api_id: g.id,
    title: g.title,
    body_html: g.descriptionHtml,
    vendor: g.vendor,
    product_type: g.productType,
    handle: g.handle,
    status: String(g.status ?? "").toLowerCase(),
    tags: Array.isArray(g.tags) ? g.tags.join(", ") : (g.tags ?? ""),
    template_suffix: g.templateSuffix ?? null,
    // Match the products/update webhook category shape (gid under
    // admin_graphql_api_id) so first-edit diffs + reverts line up.
    category: g.category
      ? { admin_graphql_api_id: g.category.id, name: g.category.name }
      : null,
    variants,
  };
}

/**
 * Field-aware diff for the first event (REST baseline vs REST webhook payload).
 * Returns REST top-level keys that changed — only the ones the history surfaces,
 * so it avoids the shape-mismatch false positives a shallow stringify would give.
 */
export function firstEventChangedFields(
  baseline: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const norm = (v: unknown) => String(v ?? "");
  const tagsKey = (v: unknown) =>
    String(v ?? "")
      .split(/,\s*/)
      .map((t) => t.trim())
      .filter(Boolean)
      .sort()
      .join(",");

  const changed: string[] = [];
  for (const f of [
    "title",
    "body_html",
    "vendor",
    "product_type",
    "handle",
    "status",
  ]) {
    if (norm(baseline[f]) !== norm(after[f])) changed.push(f);
  }
  if (tagsKey(baseline.tags) !== tagsKey(after.tags)) changed.push("tags");

  // Category (in the 2024-10+ webhook): compare by taxonomy gid, na = cleared.
  const catId = (c: unknown) => {
    const id = (c as { admin_graphql_api_id?: string } | null)
      ?.admin_graphql_api_id;
    return !id || id.endsWith("/na") ? "" : id;
  };
  if (catId(baseline.category) !== catId(after.category)) changed.push("category");

  const bVars = (baseline.variants as Array<Record<string, unknown>>) ?? [];
  const aVars = (after.variants as Array<Record<string, unknown>>) ?? [];
  const variantChanged = aVars.some((av) => {
    const bv = bVars.find(
      (v) => v.admin_graphql_api_id === av.admin_graphql_api_id,
    );
    return (
      !!bv &&
      ["price", "compare_at_price", "barcode", "sku"].some(
        (s) => norm(bv[s]) !== norm(av[s]),
      )
    );
  });
  if (variantChanged) changed.push("variants");

  return changed;
}

/**
 * Get change history for a resource.
 */
export async function getChangeHistory(
  storeId: string,
  resourceType?: ResourceType,
  resourceId?: string,
  limit = 50,
) {
  const where: Record<string, unknown> = { storeId };
  if (resourceType) where.resourceType = resourceType;
  if (resourceId) where.resourceId = resourceId;

  return prisma.changeLog.findMany({
    where,
    orderBy: { changedAt: "desc" },
    take: limit,
  });
}

/**
 * Get the before/after diff for a specific change.
 */
export async function getChangeDiff(changeId: string) {
  const change = await prisma.changeLog.findUnique({ where: { id: changeId } });
  if (!change) return null;

  const before = change.beforePath ? await storage.get(change.beforePath) : null;
  const after = change.afterPath ? await storage.get(change.afterPath) : null;

  return {
    change,
    before: before ? JSON.parse(before) : null,
    after: after ? JSON.parse(after) : null,
  };
}

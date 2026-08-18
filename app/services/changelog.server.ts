import prisma from "../db.server";
import { storage } from "./storage.server";
import type { ResourceType, ChangeAction, Plan } from "@prisma/client";
import { isNoiseOnly } from "./noise-fields";

/**
 * Whether a store is entitled to the webhook-driven change ledger.
 *
 * Real-time change tracking, the change history and field-level undo are all
 * sold as Premium ($19/mo). This used to be gated on `webhooksEnabled` alone —
 * but afterAuth sets that true for every install regardless of plan and
 * nothing ever keys it on the plan, so every Free and Standard store got the
 * paid tier's flagship feature for nothing. Both conditions are required:
 * webhooksEnabled remains the lifecycle switch (uninstall turns it off), and
 * the plan is the entitlement.
 *
 * Non-Premium stores are not left without a changed-products view — the
 * all-tiers fallback in api.changed-products compares each backed-up product's
 * live updatedAt against the backup instead.
 */
export function isChangeTrackingEntitled(
  store: { plan: Plan; webhooksEnabled: boolean } | null | undefined,
): boolean {
  return !!store && store.webhooksEnabled && store.plan === "PREMIUM";
}

/**
 * The most recent ChangeLog row holding a FULL snapshot of this resource.
 * Skips our synthetic cost/inventory/metafield events (minimal blobs, named
 * `…-inv-after.json` / `…-mf-after.json`, historically `…-cost-after.json`) —
 * diffing a full product against one of those would flag every field as
 * changed. Filtered in the DB so any run of consecutive synthetic rows can't
 * push the real baseline out of a scan window.
 */
export function findLastFullSnapshot(
  storeId: string,
  resourceType: ResourceType,
  resourceId: string,
) {
  return prisma.changeLog.findFirst({
    where: {
      storeId,
      resourceType,
      resourceId,
      afterPath: { not: null },
      AND: [
        { NOT: { afterPath: { endsWith: "-cost-after.json" } } },
        { NOT: { afterPath: { endsWith: "-inv-after.json" } } },
        { NOT: { afterPath: { endsWith: "-mf-after.json" } } },
      ],
    },
    orderBy: { changedAt: "desc" },
  });
}

/**
 * Record a change from a webhook event.
 * Stores before/after snapshots and identifies changed fields.
 * `hidden` marks revert-generated events: recorded (so the diff baseline
 * advances) but not shown in the merchant-facing history.
 * `webhookEventId` is the idempotency key: a retried event that already
 * recorded a row (e.g. its COMPLETED update failed afterwards) is a no-op.
 */
export async function recordChange(
  storeId: string,
  resourceType: ResourceType,
  resourceId: string,
  action: ChangeAction,
  data: unknown,
  hidden = false,
  webhookEventId?: string,
): Promise<string | null> {
  // Premium entitlement + the lifecycle switch — see isChangeTrackingEntitled.
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!isChangeTrackingEntitled(store)) return null;

  if (webhookEventId) {
    const existing = await prisma.changeLog.findFirst({
      where: { webhookEventId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const timestamp = Date.now();
  const afterPath = `${storeId}/changes/${resourceType}/${encodeURIComponent(resourceId)}/${timestamp}-after.json`;

  // Store the current state
  await storage.put(afterPath, JSON.stringify(data, null, 2));

  // Find the previous state (from last backup or last change)
  let beforePath: string | null = null;
  const changedFields: string[] = [];

  if (action === "UPDATED") {
    const lastChange = await findLastFullSnapshot(
      storeId,
      resourceType,
      resourceId,
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
        include: { backup: { select: { createdAt: true } } },
      });
      const raw = backupItem ? await storage.get(backupItem.storagePath) : null;
      if (raw) {
        const restBaseline = graphqlBackupToRest(JSON.parse(raw));
        // Backups that predate publishedAt capture leave published_at out of
        // the baseline, which would make a PUBLISH as the first post-backup
        // edit undetectable. published_at is the time of the LAST publish, so
        // a value newer than the backup means the product cannot have been
        // published when the backup ran (an intermediate un/republish would
        // have fired webhooks recorded before this first-event branch) — seed
        // the baseline as unpublished so the diff, the history row (which
        // needs the key in `before`) and undo all work. Future-dated values
        // are scheduled publishing possibly set up before the backup — skip
        // them (a genuine publish is always in the past by processing time).
        // An UNPUBLISH as the first edit stays undetectable for such backups
        // (the payload carries only null; the backup has no state to compare).
        if (!("published_at" in restBaseline)) {
          const backedUpAt = backupItem?.backup.createdAt.getTime();
          const p = (data as Record<string, unknown>).published_at;
          const pMs = typeof p === "string" ? Date.parse(p) : NaN;
          if (
            backedUpAt != null &&
            Number.isFinite(pMs) &&
            pMs > backedUpAt &&
            pMs <= Date.now()
          ) {
            restBaseline.published_at = null;
          }
        }
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

  // Nothing the merchant would recognise as an edit — only bookkeeping keys
  // moved (updated_at always does). Recording it would put a product nobody
  // touched into "Restore changes" and burn a row plus a blob every time
  // Shopify re-emits a product. The after-blob is written above, before the
  // diff exists, so drop it too rather than orphan it.
  //
  // Only when a diff WAS computed: an empty changedFields means no baseline
  // was available, which the consumers read as "assume it changed".
  if (action === "UPDATED" && isNoiseOnly(changedFields)) {
    try {
      await storage.delete(afterPath);
    } catch {
      // Best effort: a stranded blob is harmless, a thrown webhook is not.
    }
    return null;
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
      hidden,
      webhookEventId: webhookEventId ?? null,
    },
  });
  return created.id;
}

/**
 * Shallow comparison of two objects to find changed top-level fields.
 */
/**
 * Taxonomy id for comparison. Shopify writes a placeholder category
 * (".../TaxonomyCategory/na", name "Uncategorized") where the merchant has set
 * none, so a product saved with no category flips null -> Uncategorized. Both
 * mean "no category"; comparing them raw reports a change the merchant never
 * made. firstEventChangedFields already normalises this — computeChangedFields,
 * which runs for every edit after the first, did not.
 */
function categoryKey(c: unknown): string {
  const id = (c as { admin_graphql_api_id?: string } | null)
    ?.admin_graphql_api_id;
  return !id || id.endsWith("/na") ? "" : id;
}

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

    if (!prefix && key === "category") {
      if (categoryKey(beforeVal) !== categoryKey(afterVal)) result.push(fullKey);
      continue;
    }

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
    // Only present when the backup carried it (older backups didn't fetch
    // publishedAt) — the first-edit diff skips the field when absent, and the
    // history's published_at row requires the key in `before`.
    ...(g.publishedAt !== undefined
      ? { published_at: g.publishedAt ?? null }
      : {}),
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
    "template_suffix",
  ]) {
    if (norm(baseline[f]) !== norm(after[f])) changed.push(f);
  }
  if (tagsKey(baseline.tags) !== tagsKey(after.tags)) changed.push("tags");

  // Publish state (Online Store): timestamp set vs null — compare published-ness
  // like the history does. Skip when the baseline doesn't carry the field
  // (backups made before publishedAt was captured) to avoid phantom rows.
  if (
    "published_at" in baseline &&
    !!baseline.published_at !== !!after.published_at
  ) {
    changed.push("published_at");
  }

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

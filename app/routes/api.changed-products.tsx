import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { NOISE_KEYS } from "../services/noise-fields";
import { graphqlWithRetry } from "../services/backup.server";
import { isChangeTrackingEntitled } from "../services/changelog.server";

/**
 * API endpoint for the Restore Changed Products extension.
 * Returns products that have been modified since the last completed backup.
 *
 * Strategy:
 * - Premium tier (plan + webhooksEnabled): Query ChangeLog for UPDATED products
 *   after last backup, drop events the merchant fully undid, and only list
 *   products that still exist (deleted ones belong to the Recover Deleted flow).
 * - All tiers fallback: compare every backed-up product's live updatedAt
 *   against the backup's completion time. Show mismatches.
 *
 * GET /api/changed-products
 */

// REST webhook payload keys that bump on essentially every update and aren't
// user-facing changes. Mirrors NOISE_KEYS in api.product-history.tsx.

/**
 * Does this event still carry a visible change the merchant hasn't undone via
 * per-field Undo? undoneFields holds granular tokens ("title",
 * "variant:price:<gid>", "metafield:<ns>|<key>") while changedFields holds
 * top-level REST keys, so variants/metafields coverage is approximate: any
 * undone token of the family counts as covering the field (events almost
 * always carry one granular change per family). Mirrored in
 * api.backup-status.tsx so the badge and this list agree.
 */
function hasActiveChange(
  changedFields: string[],
  undoneFields: string[],
): boolean {
  // Legacy rows recorded without a diff — assume still relevant.
  if (changedFields.length === 0) return true;
  const visible = changedFields.filter((f) => !NOISE_KEYS.has(f));
  return visible.some((f) => {
    if (undoneFields.includes(f)) return false;
    if (f === "variants" && undoneFields.some((u) => u.startsWith("variant:"))) {
      return false;
    }
    if (
      f === "metafields" &&
      undoneFields.some((u) => u.startsWith("metafield:"))
    ) {
      return false;
    }
    return true;
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);

  // Batched live lookup: which of these product GIDs still exist, and when
  // were they last updated? nodes() accepts at most 250 ids per call, and
  // each returned node costs ~1 rate-limit point — on large catalogs this
  // sequential loop drains the bucket mid-way, so every call goes through
  // graphqlWithRetry (backs off on THROTTLED/429) instead of failing the
  // whole loader with a 500.
  const fetchLiveProducts = async (
    ids: string[],
  ): Promise<Map<string, { title: string; updatedAt: string }>> => {
    const live = new Map<string, { title: string; updatedAt: string }>();
    const batchSize = 250;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const response = await graphqlWithRetry(
        admin,
        `#graphql
          query CheckProducts($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                updatedAt
              }
            }
          }
        `,
        { variables: { ids: batch } },
      );
      const result = await response.json();
      const nodes = (result.data?.nodes || []) as Array<{
        id?: string;
        title?: string;
        updatedAt?: string;
      } | null>;
      for (const node of nodes) {
        if (node?.id) {
          live.set(node.id, {
            title: node.title || "Unknown Product",
            updatedAt: node.updatedAt || "",
          });
        }
      }
    }
    return live;
  };

  const store = await prisma.store.findUnique({
    where: { id: session.shop },
  });

  // Find the latest completed backup for this store
  const latestBackup = await prisma.backup.findFirst({
    where: { storeId: session.shop, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });

  if (!latestBackup) {
    return cors(json({ products: [], message: "No completed backups yet. Run a backup first." }));
  }

  // Strategy 1: the Premium change ledger. Gated on the plan, not just
  // webhooksEnabled — that flag is true for every install, so gating on it
  // alone served this paid feature to Free and Standard stores too.
  if (isChangeTrackingEntitled(store)) {
    // One pass, newest first: latest event + event count per product. Events
    // whose every visible field was undone per-field don't count — that
    // product matches its backup again.
    const byProduct = new Map<
      string,
      { changedAt: Date; changedFields: string[]; changeCount: number }
    >();

    // Read the WHOLE ledger window since the last backup, in pages so memory
    // stays bounded per query. A single capped read would silently drop
    // products exactly in the mass-damage scenario this list exists for: a
    // bad bulk edit writes at least one ledger row per touched product, so
    // 3000 retagged products would blow past any fixed cap and the extension
    // would present the truncated list as complete.
    const PAGE_SIZE = 1000;
    let cursorId: string | undefined;
    for (;;) {
      const page = await prisma.changeLog.findMany({
        where: {
          storeId: session.shop,
          resourceType: "PRODUCT",
          action: "UPDATED",
          changedAt: { gt: latestBackup.createdAt },
          // Skip our own revert echoes and events undone by "Revert all to
          // backup" — a reverted product matches its backup again and should
          // drop off this list.
          hidden: false,
        },
        // id breaks changedAt ties so the cursor never skips or repeats rows.
        // (Prisma treats an undefined cursor as "start from the top".)
        orderBy: [{ changedAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE,
        cursor: cursorId ? { id: cursorId } : undefined,
        skip: cursorId ? 1 : 0,
        select: {
          id: true,
          resourceId: true,
          changedAt: true,
          changedFields: true,
          undoneFields: true,
        },
      });

      for (const entry of page) {
        if (!hasActiveChange(entry.changedFields, entry.undoneFields)) continue;
        const agg = byProduct.get(entry.resourceId);
        if (agg) {
          agg.changeCount += 1;
        } else {
          byProduct.set(entry.resourceId, {
            changedAt: entry.changedAt,
            // Surface only user-facing fields (updated_at & co. are noise that
            // would displace the real fields in the extension's 3 slots).
            changedFields: entry.changedFields.filter((f) => !NOISE_KEYS.has(f)),
            changeCount: 1,
          });
        }
      }

      if (page.length < PAGE_SIZE) break;
      cursorId = page[page.length - 1].id;
    }

    if (byProduct.size === 0) {
      return cors(json({ products: [] }));
    }

    // One grouped lookup instead of a findFirst per product.
    const backupItems = await prisma.backupItem.findMany({
      where: {
        backupId: latestBackup.id,
        resourceType: "PRODUCT",
        resourceId: { in: [...byProduct.keys()] },
      },
      select: { id: true, resourceId: true, title: true },
    });
    const itemByResource = new Map(
      backupItems.map((item) => [item.resourceId, item]),
    );

    // A product deleted after its change can't be reverted (its Revert would
    // fail every time) — that's the Recover Deleted flow's job. Only list
    // products that still exist.
    const candidates = [...byProduct.keys()].filter((id) =>
      itemByResource.has(id),
    );
    const live = await fetchLiveProducts(candidates);

    const products = candidates.flatMap((resourceId) => {
      const item = itemByResource.get(resourceId);
      const agg = byProduct.get(resourceId);
      if (!item || !agg || !live.has(resourceId)) return [];
      return [
        {
          backupItemId: item.id,
          resourceId,
          title: item.title || "Unknown Product",
          changedAt: agg.changedAt.toISOString(),
          changedFields: agg.changedFields,
          changeCount: agg.changeCount,
        },
      ];
    });

    return cors(json({ products }));
  }

  // Strategy 2: Compare every backed-up product against live Shopify. No take
  // limit — partial coverage would silently hide changes on the rest of the
  // catalog.
  const backupItems = await prisma.backupItem.findMany({
    where: {
      backupId: latestBackup.id,
      resourceType: "PRODUCT",
    },
    select: { id: true, resourceId: true },
  });

  if (backupItems.length === 0) {
    return cors(json({ products: [] }));
  }

  const itemByResource = new Map(
    backupItems.map((item) => [item.resourceId, item]),
  );
  const live = await fetchLiveProducts([...itemByResource.keys()]);

  // A COMPLETED backup's updatedAt is when it finished. Comparing against
  // createdAt (its start) would flag products edited while the backup was
  // still capturing them, even though the snapshot already holds the new state.
  const backupFinishedAt = latestBackup.updatedAt;

  const changedProducts = [];
  for (const [resourceId, node] of live) {
    // If the product was updated after our last backup finished, it has changes
    if (new Date(node.updatedAt) > backupFinishedAt) {
      const item = itemByResource.get(resourceId);
      if (item) {
        changedProducts.push({
          backupItemId: item.id,
          resourceId,
          title: node.title,
          changedAt: node.updatedAt,
          changedFields: [] as string[],
          changeCount: 1,
        });
      }
    }
  }

  return cors(json({ products: changedProducts }));
};

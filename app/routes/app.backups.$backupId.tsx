import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useEffect, useState } from "react";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Tabs,
  IndexTable,
  useIndexResourceState,
  EmptyState,
  Banner,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { restoreItems } from "../services/restore.server";
import { graphqlWithRetry } from "../services/backup.server";

/**
 * Per-backup restore view. Compares a CHOSEN backup's products against the live
 * store and lists which are DELETED (no longer exist) vs CHANGED (exist but
 * edited since the backup), with filtering, multi-select, and bulk restore.
 * Non-product content (collections, pages, blog posts, redirects, menus) is
 * listed separately with per-item restore.
 *
 * Deleted → re-created as a draft via /api/restore-product.
 * Changed → reverted to the backup via /api/revert-product.
 * Other content → restoreItems (restore.server), per item.
 *
 * There is deliberately NO "Restore all" action: restoreItems re-CREATES
 * resources (restoreProduct omits the productSet identifier, and the
 * collection/page/redirect paths use create mutations), so replaying every
 * item in the backup would duplicate anything that still exists in the store
 * instead of reverting it.
 *
 * Change detection uses live updatedAt > backup.createdAt (batched nodes()
 * queries with throttle retry), matching the /api/changed-products fallback
 * strategy.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const backupId = params.backupId as string;

  const backup = await prisma.backup.findFirst({
    where: { id: backupId, storeId: session.shop },
  });
  if (!backup) {
    throw redirect("/app");
  }

  // Every item, stably ordered — a row cap here would silently hide deleted
  // products from what is their only recovery path for older backups.
  const allItems = await prisma.backupItem.findMany({
    where: { backupId },
    select: { id: true, resourceType: true, resourceId: true, title: true },
    orderBy: [{ resourceType: "asc" }, { title: "asc" }],
  });
  const items = allItems.filter((it) => it.resourceType === "PRODUCT");

  // Batch-check live existence + updatedAt for all backed-up products.
  // nodes() accepts at most 250 ids per call, and each returned node costs
  // ~1 rate-limit point — on large catalogs the sequential loop drains the
  // bucket mid-way, so every call goes through graphqlWithRetry (backs off
  // on THROTTLED/429) instead of failing the whole loader with a 500.
  const liveUpdatedAt = new Map<string, string>();
  const batchSize = 250;
  for (let i = 0; i < items.length; i += batchSize) {
    const ids = items.slice(i, i + batchSize).map((it) => it.resourceId);
    const resp = await graphqlWithRetry(
      admin,
      `#graphql
        query CheckProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              updatedAt
            }
          }
        }`,
      { variables: { ids } },
    );
    const result = await resp.json();
    for (const n of (result.data?.nodes || []) as Array<{
      id?: string;
      updatedAt?: string;
    } | null>) {
      if (n?.id) liveUpdatedAt.set(n.id, n.updatedAt || "");
    }
  }

  const backupTime = backup.createdAt.getTime();
  const deleted: Array<{ backupItemId: string; title: string }> = [];
  const changed: Array<{ backupItemId: string; title: string }> = [];
  for (const it of items) {
    const title = it.title || "Untitled product";
    if (!liveUpdatedAt.has(it.resourceId)) {
      deleted.push({ backupItemId: it.id, title });
    } else {
      const u = liveUpdatedAt.get(it.resourceId);
      if (u && new Date(u).getTime() > backupTime) {
        changed.push({ backupItemId: it.id, title });
      }
    }
  }

  return json({
    backup: {
      id: backup.id,
      createdAt: backup.createdAt.toISOString(),
      errorMessage: backup.errorMessage,
    },
    deleted,
    changed,
    otherItems: allItems
      .filter((it) => it.resourceType !== "PRODUCT")
      .map((it) => ({
        id: it.id,
        resourceType: it.resourceType,
        title: it.title || it.resourceId,
      })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "restore") {
    const itemIds = formData.getAll("itemId") as string[];
    if (itemIds.length === 0) {
      return json({ success: false, error: "No items selected" });
    }

    // Provide REST context for resource types that need the REST Admin API
    // (blog articles and theme assets).
    const rest = session.accessToken
      ? { shop: session.shop, accessToken: session.accessToken }
      : undefined;

    const results = await restoreItems(admin, session.shop, itemIds, rest);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return json({
      success: true,
      results: { succeeded, failed, details: results },
    });
  }

  return json({ success: false, error: "Unknown action" });
};

// The server renders in its own timezone (UTC on Azure) while the browser
// re-renders in the merchant's, so locale formatting during SSR would produce
// hydration text mismatches. Until hydration we render a deterministic,
// labeled UTC string; after mount the merchant-local format takes over.
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

function formatDate(iso: string, hydrated: boolean): string {
  const date = new Date(iso);
  if (!hydrated) {
    const utc = date.toISOString();
    return `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC`;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const resourceTypeLabels: Record<string, string> = {
  PRODUCT: "Product",
  COLLECTION: "Collection",
  PAGE: "Page",
  BLOG_POST: "Blog Post",
  REDIRECT: "Redirect",
  THEME: "Theme",
  MENU: "Menu",
  POLICY: "Policy",
  METAOBJECT: "Metaobject",
};

type Row = {
  id: string;
  backupItemId: string;
  title: string;
  type: "deleted" | "changed";
};

export default function BackupRestore() {
  const { backup, deleted, changed, otherItems } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submit = useSubmit();
  const hydrated = useHydrated();
  const isRestoring = navigation.state === "submitting";
  const [tab, setTab] = useState(0);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const allRows: Row[] = [
    ...deleted.map((d) => ({
      id: d.backupItemId,
      backupItemId: d.backupItemId,
      title: d.title,
      type: "deleted" as const,
    })),
    ...changed.map((c) => ({
      id: c.backupItemId,
      backupItemId: c.backupItemId,
      title: c.title,
      type: "changed" as const,
    })),
  ];

  const tabs = [
    { id: "all", content: `All (${allRows.length})` },
    { id: "deleted", content: `Deleted (${deleted.length})` },
    { id: "changed", content: `Changed (${changed.length})` },
  ];
  const rows =
    tab === 1
      ? allRows.filter((r) => r.type === "deleted")
      : tab === 2
        ? allRows.filter((r) => r.type === "changed")
        : allRows;

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(rows);

  async function restoreOne(row: Row): Promise<void> {
    setPending((p) => ({ ...p, [row.id]: true }));
    setErrors((p) => ({ ...p, [row.id]: "" }));
    try {
      const endpoint =
        row.type === "deleted" ? "/api/restore-product" : "/api/revert-product";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupItemId: row.backupItemId }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        setDone((p) => ({
          ...p,
          [row.id]: row.type === "deleted" ? "Recovered as draft" : "Reverted",
        }));
      } else {
        setErrors((p) => ({ ...p, [row.id]: result.error || "Failed" }));
      }
    } catch {
      setErrors((p) => ({ ...p, [row.id]: "Network error" }));
    } finally {
      setPending((p) => ({ ...p, [row.id]: false }));
    }
  }

  async function handleBulk() {
    const targets = rows.filter(
      (r) => selectedResources.includes(r.id) && !done[r.id],
    );
    for (const row of targets) {
      await restoreOne(row);
    }
  }

  const handleRestoreItem = (itemId: string) => {
    const formData = new FormData();
    formData.set("action", "restore");
    formData.append("itemId", itemId);
    submit(formData, { method: "POST" });
  };

  const rowMarkup = rows.map((row, index) => (
    <IndexTable.Row
      id={row.id}
      key={row.id}
      selected={selectedResources.includes(row.id)}
      position={index}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {row.title}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={row.type === "deleted" ? "critical" : "warning"}>
          {row.type === "deleted" ? "Deleted" : "Changed"}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {done[row.id] ? (
          <Badge tone="success">{done[row.id]}</Badge>
        ) : errors[row.id] ? (
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="critical">Failed</Badge>
            <Button
              size="slim"
              onClick={() => restoreOne(row)}
              loading={pending[row.id]}
            >
              Retry
            </Button>
          </InlineStack>
        ) : (
          <Button
            size="slim"
            onClick={() => restoreOne(row)}
            loading={pending[row.id]}
            disabled={pending[row.id]}
          >
            {row.type === "deleted" ? "Recover" : "Undo"}
          </Button>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const otherRows = otherItems.map((item) => [
    <Badge key={`type-${item.id}`}>
      {resourceTypeLabels[item.resourceType] || item.resourceType}
    </Badge>,
    item.title,
    <Button
      key={`restore-${item.id}`}
      size="slim"
      onClick={() => handleRestoreItem(item.id)}
      disabled={isRestoring}
    >
      Restore
    </Button>,
  ]);

  return (
    <Page
      backAction={{ content: "Backups", onAction: () => navigate("/app") }}
      title="Restore from backup"
      subtitle={formatDate(backup.createdAt, hydrated)}
    >
      <TitleBar title="Restore from backup" />
      <BlockStack gap="400">
        {backup.errorMessage && (
          <Banner title="Backup had errors" tone="critical">
            <p>{backup.errorMessage}</p>
          </Banner>
        )}
        {actionData && "results" in actionData ? (
          <Banner
            tone={actionData.results.failed === 0 ? "success" : "warning"}
          >
            <p>
              Restored {actionData.results.succeeded} item(s)
              {actionData.results.failed > 0
                ? `, ${actionData.results.failed} failed`
                : ""}
              .
            </p>
          </Banner>
        ) : actionData ? (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        ) : null}
        <Banner tone="info">
          <p>
            Recover deleted products (re-created as drafts) or undo changes
            (reverted to this backup). Select rows to restore several at once.
          </p>
        </Banner>
        <Card padding="0">
          <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
          {allRows.length === 0 ? (
            <EmptyState
              heading="Nothing to restore"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Every product in this backup still matches your store.</p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "product", plural: "products" }}
              itemCount={rows.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={[
                { content: "Restore selected", onAction: handleBulk },
              ]}
              headings={[
                { title: "Product" },
                { title: "Type" },
                { title: "Status" },
              ]}
            >
              {rowMarkup}
            </IndexTable>
          )}
        </Card>
        {otherItems.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Other content ({otherItems.length})
              </Text>
              <Text as="p" tone="subdued">
                Collections, pages, blog posts, redirects, and menus from this
                backup. Restoring re-creates or overwrites the live version.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Type", "Name", "Action"]}
                rows={otherRows}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

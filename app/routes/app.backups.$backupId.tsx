import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData, useNavigate } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Per-backup restore view. Compares a CHOSEN backup's products against the live
 * store and lists which are DELETED (no longer exist) vs CHANGED (exist but
 * edited since the backup), with filtering, multi-select, and bulk restore.
 *
 * Deleted → re-created as a draft via /api/restore-product.
 * Changed → reverted to the backup via /api/revert-product.
 *
 * Change detection uses live updatedAt > backup.createdAt (one batched query),
 * matching the /api/changed-products fallback strategy.
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

  const items = await prisma.backupItem.findMany({
    where: { backupId, resourceType: "PRODUCT" },
    select: { id: true, resourceId: true, title: true },
    take: 250,
  });

  // Batch-check live existence + updatedAt for all backed-up products.
  const liveUpdatedAt = new Map<string, string>();
  const batchSize = 50;
  for (let i = 0; i < items.length; i += batchSize) {
    const ids = items.slice(i, i + batchSize).map((it) => it.resourceId);
    const resp = await admin.graphql(
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
    backup: { id: backup.id, createdAt: backup.createdAt.toISOString() },
    deleted,
    changed,
  });
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Row = {
  id: string;
  backupItemId: string;
  title: string;
  type: "deleted" | "changed";
};

export default function BackupRestore() {
  const { backup, deleted, changed } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
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

  return (
    <Page
      backAction={{ content: "Backups", onAction: () => navigate("/app") }}
      title="Restore from backup"
      subtitle={formatDate(backup.createdAt)}
    >
      <TitleBar title="Restore from backup" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Recover deleted products (re-created as drafts) or undo changes
            (reverted to this backup). Select rows to restore in bulk.
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
      </BlockStack>
    </Page>
  );
}

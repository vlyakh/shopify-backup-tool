import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [changeLogCount, backupItemCount, latestBackup, recent] =
    await Promise.all([
      prisma.changeLog.count({ where: { storeId: session.shop } }),
      prisma.backupItem.count({ where: { backup: { storeId: session.shop } } }),
      prisma.backup.findFirst({
        where: { storeId: session.shop },
        orderBy: { createdAt: "desc" },
        select: { status: true, createdAt: true, productCount: true },
      }),
      prisma.changeLog.findMany({
        where: { storeId: session.shop },
        orderBy: { changedAt: "desc" },
        take: 10,
        select: {
          changedAt: true,
          resourceId: true,
          action: true,
          changedFields: true,
        },
      }),
    ]);
  return json({
    changeLogCount,
    backupItemCount,
    latestBackup: latestBackup
      ? {
          status: latestBackup.status,
          createdAt: latestBackup.createdAt.toISOString(),
          productCount: latestBackup.productCount,
        }
      : null,
    recent: recent.map((c) => ({
      changedAt: c.changedAt.toISOString(),
      resource: c.resourceId.replace("gid://shopify/Product/", "Product #"),
      action: c.action,
      fields: c.changedFields.join(", ") || "(none)",
    })),
  });
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");

  if (intent === "clearHistory") {
    // Scoped to this store only. Also drop any queued webhook events so they
    // can't re-create history after the wipe.
    const cl = await prisma.changeLog.deleteMany({
      where: { storeId: session.shop },
    });
    const wh = await prisma.webhookEvent.deleteMany({
      where: { storeId: session.shop },
    });
    return json({
      ok: true as const,
      message: `Cleared ${cl.count} change records and ${wh.count} queued events.`,
    });
  }
  if (intent === "deleteBackups") {
    // BackupItem rows cascade on Backup delete (schema onDelete: Cascade).
    const bk = await prisma.backup.deleteMany({
      where: { storeId: session.shop },
    });
    return json({
      ok: true as const,
      message: `Deleted ${bk.count} backups (and their items).`,
    });
  }
  return json({ ok: false as const, message: "Unknown action." }, { status: 400 });
};

export default function ResetPage() {
  const state = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [confirm, setConfirm] = useState<string | null>(null);
  const submitting = fetcher.formData?.get("intent");

  const click = (intent: string) => {
    if (confirm === intent) {
      fetcher.submit({ intent }, { method: "POST" });
      setConfirm(null);
    } else {
      setConfirm(intent);
    }
  };

  return (
    <Page title="Reset data">
      <TitleBar title="Reset data" />
      <BlockStack gap="500">
        {fetcher.data ? (
          <Banner tone={fetcher.data.ok ? "success" : "critical"}>
            {fetcher.data.message}
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Current state
            </Text>
            <Text as="p" variant="bodyMd">
              Change records (this store): {state.changeLogCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Latest backup:{" "}
              {state.latestBackup
                ? `${state.latestBackup.status} · ${fmt(state.latestBackup.createdAt)} · ${state.latestBackup.productCount} products`
                : "none yet — run one before editing"}
            </Text>
            <Text as="p" variant="bodyMd">
              Backed-up items: {state.backupItemCount}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Recent change records (raw)
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              What the webhook actually recorded — make an edit, reload this page,
              and check that the field appears under &ldquo;fields&rdquo;.
            </Text>
            {state.recent.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                No change records yet.
              </Text>
            ) : (
              state.recent.map((c, i) => (
                <Text key={i} as="p" variant="bodyMd">
                  {fmt(c.changedAt)} · {c.action} {c.resource} · fields: {c.fields}
                </Text>
              ))
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Clear change history
            </Text>
            <Text as="p" tone="subdued">
              Deletes this store&rsquo;s Undo ledger (every tracked edit) and any
              queued webhook events. Backups are kept. Use this to start testing
              from a clean slate.
            </Text>
            <InlineStack>
              <Button
                variant="primary"
                tone="critical"
                loading={submitting === "clearHistory"}
                onClick={() => click("clearHistory")}
              >
                {confirm === "clearHistory"
                  ? "Click again to confirm — clears all history"
                  : "Clear change history"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Delete all backups
            </Text>
            <Text as="p" tone="subdued">
              Permanently removes every snapshot for this store. Can&rsquo;t be
              undone. Run a fresh backup afterward so edits have a baseline to undo
              against.
            </Text>
            <InlineStack>
              <Button
                variant="primary"
                tone="critical"
                loading={submitting === "deleteBackups"}
                onClick={() => click("deleteBackups")}
              >
                {confirm === "deleteBackups"
                  ? "Click again to confirm — deletes all backups"
                  : "Delete all backups"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

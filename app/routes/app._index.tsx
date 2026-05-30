import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Badge,
  DataTable,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runBackup } from "../services/backup.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Ensure store record exists
  await prisma.store.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  const store = await prisma.store.findUnique({ where: { id: shop } });

  const backups = await prisma.backup.findMany({
    where: { storeId: shop },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      _count: { select: { items: true } },
    },
  });

  const totalBackups = await prisma.backup.count({ where: { storeId: shop } });
  const lastBackup = backups[0] || null;

  return json({
    shop,
    store,
    backups: backups.map((b) => ({
      id: b.id,
      status: b.status,
      trigger: b.trigger,
      createdAt: b.createdAt.toISOString(),
      productCount: b.productCount,
      collectionCount: b.collectionCount,
      pageCount: b.pageCount,
      blogPostCount: b.blogPostCount,
      redirectCount: b.redirectCount,
      itemCount: b._count.items,
      errorMessage: b.errorMessage,
    })),
    totalBackups,
    lastBackup: lastBackup
      ? {
          id: lastBackup.id,
          status: lastBackup.status,
          createdAt: lastBackup.createdAt.toISOString(),
          productCount: lastBackup.productCount,
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "backup") {
    const store = await prisma.store.findUnique({ where: { id: shop } });
    try {
      const backupId = await runBackup(admin, shop, "MANUAL", store?.plan || "FREE");
      return json({ success: true, backupId });
    } catch (error) {
      return json({
        success: false,
        error: error instanceof Error ? error.message : "Backup failed",
      });
    }
  }

  return json({ success: false, error: "Unknown action" });
};

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const toneMap: Record<string, "success" | "attention" | "critical" | undefined> = {
    COMPLETED: "success",
    IN_PROGRESS: "attention",
    FAILED: "critical",
  };
  const labelMap: Record<string, string> = {
    COMPLETED: "Completed",
    IN_PROGRESS: "In Progress",
    FAILED: "Failed",
    PENDING: "Pending",
  };
  return <Badge tone={toneMap[status]}>{labelMap[status] || status}</Badge>;
}

function TriggerBadge({ trigger }: { trigger: string }) {
  const toneMap: Record<string, "info" | "warning" | undefined> = {
    SCHEDULED: "info",
    WEBHOOK: "warning",
  };
  const labelMap: Record<string, string> = {
    MANUAL: "Manual",
    SCHEDULED: "Scheduled",
    WEBHOOK: "Real-time",
  };
  return <Badge tone={toneMap[trigger]}>{labelMap[trigger] || trigger}</Badge>;
}

export default function Index() {
  const { store, backups, totalBackups, lastBackup } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBackingUp = navigation.state === "submitting";

  const handleBackup = () => {
    submit({ action: "backup" }, { method: "POST" });
  };

  const planLabel =
    store?.plan === "PREMIUM"
      ? "Premium"
      : store?.plan === "STANDARD"
        ? "Standard"
        : "Free";

  const rows = backups.map((backup) => [
    formatDate(backup.createdAt),
    <StatusBadge key={backup.id} status={backup.status} />,
    <TriggerBadge key={`t-${backup.id}`} trigger={backup.trigger} />,
    [
      backup.productCount > 0 && `${backup.productCount} products`,
      backup.collectionCount > 0 && `${backup.collectionCount} collections`,
      backup.pageCount > 0 && `${backup.pageCount} pages`,
      backup.blogPostCount > 0 && `${backup.blogPostCount} posts`,
      backup.redirectCount > 0 && `${backup.redirectCount} redirects`,
    ]
      .filter(Boolean)
      .join(", ") || "Empty",
    String(backup.itemCount),
  ]);

  return (
    <Page>
      <TitleBar title="Store Backup" />
      <BlockStack gap="500">
        {/* Stats Overview */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Plan
                </Text>
                <Text as="p" variant="headingLg">
                  {planLabel}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {store?.retentionDays}-day retention
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Total Backups
                </Text>
                <Text as="p" variant="headingLg">
                  {totalBackups}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {store?.autoBackupEnabled ? "Auto-backup enabled" : "Manual only"}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Last Backup
                </Text>
                <Text as="p" variant="headingLg">
                  {lastBackup ? `${lastBackup.productCount} products` : "Never"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {lastBackup ? formatDate(lastBackup.createdAt) : "Run your first backup"}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Action Bar */}
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Backup Now
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Create a snapshot of your store data. Products are always included.
                {store?.plan !== "FREE" &&
                  " Collections, pages, blogs, redirects, and menus are also backed up."}
              </Text>
            </BlockStack>
            <Button
              variant="primary"
              onClick={handleBackup}
              loading={isBackingUp}
              disabled={isBackingUp}
            >
              {isBackingUp ? "Backing up..." : "Run Backup"}
            </Button>
          </InlineStack>
        </Card>

        {/* Backup History */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Backup History
            </Text>
            {backups.length === 0 ? (
              <EmptyState
                heading="No backups yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Run your first backup to protect your store data.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric"]}
                headings={["Date", "Status", "Trigger", "Contents", "Items"]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        {/* Plan Upgrade Banner */}
        {store?.plan === "FREE" && (
          <Banner
            title="Upgrade for full protection"
            tone="info"
            action={{ content: "View Plans", url: "/app/settings" }}
          >
            <p>
              Free plan backs up products only with 7-day retention. Upgrade to back up
              collections, pages, blogs, redirects, and menus with longer retention and
              automatic daily backups.
            </p>
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}

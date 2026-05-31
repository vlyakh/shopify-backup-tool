import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useEffect, useState } from "react";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useNavigate,
  useRevalidator,
  useFetcher,
} from "@remix-run/react";
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
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runBackup } from "../services/backup.server";
import type { loader as changedProductsLoader } from "./api.changed-products";
import type { loader as deletedProductsLoader } from "./api.deleted-products";

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
      processedCount: b.processedCount,
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

type ChangedProduct = {
  backupItemId: string;
  resourceId: string;
  title: string;
  changedAt: string;
  changedFields: string[];
  changeCount: number;
};

/**
 * "Restore changes" card. Lists products that have been modified since the last
 * completed backup (via GET /api/changed-products) and lets the merchant revert
 * each one to its backed-up version (POST /api/revert-product).
 *
 * Fully client-driven so the page loader/action stay untouched:
 *  - useFetcher loads the changed-products list on mount.
 *  - Per-row revert uses a same-origin client fetch. This is an embedded app
 *    route (NOT a cross-origin extension), so sending Content-Type: application/json
 *    is fine here — there's no CORS preflight to worry about.
 *  - After a successful revert the row's product drops off, so we re-load the list.
 */
function RestoreChanges() {
  const changedFetcher = useFetcher<typeof changedProductsLoader>();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Load the changed-products list once on mount.
  useEffect(() => {
    if (changedFetcher.state === "idle" && !changedFetcher.data) {
      changedFetcher.load("/api/changed-products");
    }
  }, [changedFetcher]);

  const products = (changedFetcher.data?.products ?? []) as ChangedProduct[];
  const isLoading = changedFetcher.state !== "idle" && !changedFetcher.data;

  async function handleRevert(backupItemId: string) {
    setPending((prev) => ({ ...prev, [backupItemId]: true }));
    setErrors((prev) => ({ ...prev, [backupItemId]: "" }));

    try {
      const response = await fetch("/api/revert-product", {
        method: "POST",
        // Same-origin embedded app route: Content-Type is allowed here (no CORS
        // preflight). Extensions, by contrast, must omit it.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupItemId }),
      });
      const result = await response.json();

      if (response.ok && result.success) {
        setDone((prev) => ({
          ...prev,
          [backupItemId]: result.variantWarnings
            ? `Reverted (${result.variantWarnings.length} variant warning${
                result.variantWarnings.length !== 1 ? "s" : ""
              })`
            : "Reverted",
        }));
        // The product now matches the backup; refresh the list so it drops off.
        changedFetcher.load("/api/changed-products");
      } else {
        setErrors((prev) => ({
          ...prev,
          [backupItemId]: result.error || "Revert failed",
        }));
      }
    } catch {
      setErrors((prev) => ({ ...prev, [backupItemId]: "Network error" }));
    } finally {
      setPending((prev) => ({ ...prev, [backupItemId]: false }));
    }
  }

  let body;
  if (isLoading) {
    body = (
      <InlineStack gap="200" blockAlign="center">
        <Spinner size="small" accessibilityLabel="Loading changed products" />
        <Text as="p" variant="bodySm" tone="subdued">
          Checking for changes…
        </Text>
      </InlineStack>
    );
  } else if (products.length === 0) {
    body = (
      <Text as="p" variant="bodySm" tone="subdued">
        All products match your last backup. Nothing to restore.
      </Text>
    );
  } else {
    const rows = products.map((item) => {
      const changedSummary =
        item.changedFields && item.changedFields.length > 0
          ? `${item.changedFields.slice(0, 3).join(", ")}${
              item.changedFields.length > 3 ? "…" : ""
            }`
          : "";
      return [
        item.title || "Unknown product",
        [formatDate(item.changedAt), changedSummary].filter(Boolean).join(" · "),
        done[item.backupItemId] ? (
          <Badge key={`d-${item.backupItemId}`} tone="success">
            {done[item.backupItemId]}
          </Badge>
        ) : errors[item.backupItemId] ? (
          <InlineStack key={`e-${item.backupItemId}`} gap="200" blockAlign="center">
            <Badge tone="critical">Failed</Badge>
            <Button
              size="slim"
              onClick={() => handleRevert(item.backupItemId)}
              loading={pending[item.backupItemId]}
            >
              Retry
            </Button>
          </InlineStack>
        ) : (
          <Button
            key={`b-${item.backupItemId}`}
            size="slim"
            onClick={() => handleRevert(item.backupItemId)}
            loading={pending[item.backupItemId]}
            disabled={pending[item.backupItemId]}
          >
            Revert
          </Button>
        ),
      ];
    });

    body = (
      <DataTable
        columnContentTypes={["text", "text", "text"]}
        headings={["Product", "Changed", ""]}
        rows={rows}
      />
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Restore changes
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Products modified since your last backup. Revert any to its backed-up
            version.
          </Text>
        </BlockStack>
        {body}
      </BlockStack>
    </Card>
  );
}

type DeletedProduct = {
  backupItemId: string;
  title: string;
  deletedAt: string;
  variantCount: number;
};

/**
 * "Recover deleted products" card. Lists products that were backed up but have
 * since been deleted (via GET /api/deleted-products) and lets the merchant
 * re-create any as a new draft (POST /api/restore-product). Mirrors the
 * RestoreChanges card. Deleted products can't be reached from their own product
 * page, so recovery must live here on the dashboard list.
 */
function RecoverDeleted() {
  const fetcher = useFetcher<typeof deletedProductsLoader>();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) {
      fetcher.load("/api/deleted-products");
    }
  }, [fetcher]);

  const products = (fetcher.data?.products ?? []) as DeletedProduct[];
  const isLoading = fetcher.state !== "idle" && !fetcher.data;

  async function handleRecover(backupItemId: string) {
    setPending((prev) => ({ ...prev, [backupItemId]: true }));
    setErrors((prev) => ({ ...prev, [backupItemId]: "" }));
    try {
      const response = await fetch("/api/restore-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupItemId }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        // Recreated as a new draft; the old deleted entry stays in the list
        // (historical), so show a success badge rather than refreshing it away.
        setDone((prev) => ({ ...prev, [backupItemId]: "Recovered as draft" }));
      } else {
        setErrors((prev) => ({
          ...prev,
          [backupItemId]: result.error || "Recover failed",
        }));
      }
    } catch {
      setErrors((prev) => ({ ...prev, [backupItemId]: "Network error" }));
    } finally {
      setPending((prev) => ({ ...prev, [backupItemId]: false }));
    }
  }

  let body;
  if (isLoading) {
    body = (
      <InlineStack gap="200" blockAlign="center">
        <Spinner size="small" accessibilityLabel="Loading deleted products" />
        <Text as="p" variant="bodySm" tone="subdued">
          Checking for deleted products…
        </Text>
      </InlineStack>
    );
  } else if (products.length === 0) {
    body = (
      <Text as="p" variant="bodySm" tone="subdued">
        No deleted products to recover.
      </Text>
    );
  } else {
    const rows = products.map((item) => [
      item.title || "Unknown product",
      formatDate(item.deletedAt),
      done[item.backupItemId] ? (
        <Badge key={`d-${item.backupItemId}`} tone="success">
          {done[item.backupItemId]}
        </Badge>
      ) : errors[item.backupItemId] ? (
        <InlineStack key={`e-${item.backupItemId}`} gap="200" blockAlign="center">
          <Badge tone="critical">Failed</Badge>
          <Button
            size="slim"
            onClick={() => handleRecover(item.backupItemId)}
            loading={pending[item.backupItemId]}
          >
            Retry
          </Button>
        </InlineStack>
      ) : (
        <Button
          key={`b-${item.backupItemId}`}
          size="slim"
          onClick={() => handleRecover(item.backupItemId)}
          loading={pending[item.backupItemId]}
          disabled={pending[item.backupItemId]}
        >
          Recover
        </Button>
      ),
    ]);

    body = (
      <DataTable
        columnContentTypes={["text", "text", "text"]}
        headings={["Product", "Deleted", ""]}
        rows={rows}
      />
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Recover deleted products
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Products that were backed up but have since been deleted. Recover any
            as a new draft.
          </Text>
        </BlockStack>
        {body}
      </BlockStack>
    </Card>
  );
}

export default function Index() {
  const { store, backups, totalBackups, lastBackup } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();

  // A backup currently running (e.g. the automatic one kicked off at install).
  const activeBackup = backups.find((b) => b.status === "IN_PROGRESS");
  const isActive = Boolean(activeBackup);
  const isBackingUp = navigation.state === "submitting" || isActive;

  // Poll for live progress while a backup is running.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => revalidate(), 2000);
    return () => clearInterval(interval);
  }, [isActive, revalidate]);

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
    backup.status === "COMPLETED" ? (
      <Button
        key={`r-${backup.id}`}
        size="slim"
        onClick={() => navigate(`/app/backups/${backup.id}`)}
      >
        Restore
      </Button>
    ) : (
      ""
    ),
  ]);

  return (
    <Page>
      <TitleBar title="Store Backup" />
      <BlockStack gap="500">
        {/* Live backup progress */}
        {activeBackup && (
          <Card>
            <InlineStack gap="400" blockAlign="center">
              <Spinner accessibilityLabel="Backup in progress" size="small" />
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Backing up your store…
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {activeBackup.processedCount > 0
                    ? `${activeBackup.processedCount} items saved so far`
                    : "Starting backup…"}
                </Text>
              </BlockStack>
            </InlineStack>
          </Card>
        )}

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
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "text",
                ]}
                headings={["Date", "Status", "Trigger", "Contents", "Items", ""]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        {/* Restore changes */}
        <RestoreChanges />

        {/* Recover deleted products */}
        <RecoverDeleted />

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

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useEffect, useState } from "react";
import {
  useActionData,
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
  Checkbox,
  Select,
  DataTable,
  EmptyState,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import type { BackupInterval } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { startBackupIfIdle } from "../services/backup.server";
import { computeNextRunAt } from "../services/scheduler.server";
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
  const schedule = await prisma.backupSchedule.findUnique({
    where: { storeId: shop },
  });

  return json({
    shop,
    store,
    // "Reset data" is developer tooling — see the guard in app.reset.tsx.
    showDevTools: process.env.ENABLE_DEV_TOOLS === "true",
    schedule: schedule
      ? {
          enabled: schedule.enabled,
          interval: schedule.interval,
          nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
        }
      : null,
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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "backup") {
    // Fire-and-forget: startBackupIfIdle creates a PENDING row and runs the
    // backup in the background, so this POST returns immediately instead of
    // holding the request open for the whole catalog walk (proxy idle
    // timeouts kill long responses on large stores). It also refuses to
    // stack a second run on top of one already PENDING/IN_PROGRESS.
    const result = await startBackupIfIdle(shop, "MANUAL");
    if (!result.started) {
      return json({
        success: false,
        error:
          result.reason === "already-running"
            ? "A backup is already running — it will appear in the history below when it finishes."
            : `Could not start backup (${result.reason}).`,
      });
    }
    return json({ success: true, backupId: result.backupId });
  }

  if (actionType === "saveSchedule") {
    const enabled = formData.get("enabled") === "true";
    const interval = (formData.get("interval") as BackupInterval) || "DAILY";
    const storeRec = await prisma.store.findUnique({ where: { id: shop } });
    // Automatic backups are a paid entitlement — enforce it server-side,
    // since the schedule card is visible on every plan.
    if (enabled && (storeRec?.plan ?? "FREE") === "FREE") {
      return json({
        success: false,
        error: "Automatic backups are available on the Standard and Premium plans.",
      });
    }
    await prisma.store.update({
      where: { id: shop },
      data: { autoBackupEnabled: enabled },
    });
    // null nextRunAt while disabled; recompute the next anchored slot when
    // enabling (same computeNextRunAt the scheduler uses, so they agree).
    // Anchor on the stored weeklyDay (timestamps only as a fallback for rows
    // that predate it — the scheduler's failure path reuses nextRunAt as a
    // retry timer) so re-saving a WEEKLY schedule keeps its weekday instead
    // of jumping to the next occurrence of today's weekday.
    const existing = await prisma.backupSchedule.findUnique({
      where: { storeId: shop },
    });
    const nextRunAt = enabled
      ? computeNextRunAt(
          interval,
          storeRec?.autoBackupHour ?? 3,
          new Date(),
          existing?.weeklyDay ?? existing?.nextRunAt ?? existing?.lastRunAt,
        )
      : null;
    // Lock in the WEEKLY run day; undefined leaves the stored value alone
    // (Prisma skips undefined fields) so disabling or switching intervals
    // keeps the weekday memory.
    const weeklyDay =
      interval === "WEEKLY" && nextRunAt ? nextRunAt.getUTCDay() : undefined;
    await prisma.backupSchedule.upsert({
      where: { storeId: shop },
      create: { storeId: shop, enabled, interval, nextRunAt, weeklyDay },
      update: { enabled, interval, nextRunAt, weeklyDay },
    });
    return json({ success: true, scheduleSaved: true });
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

function formatDate(isoString: string, hydrated: boolean): string {
  const date = new Date(isoString);
  if (!hydrated) {
    const iso = date.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Download a backup's products as CSV. Fetched (App Bridge attaches the session
// token) then saved via a blob — a plain link wouldn't carry auth.
// Resolves with an error message to surface, or null on success.
async function downloadCsv(backupId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/backup-export/${backupId}`);
    if (!res.ok) {
      return `CSV export failed (HTTP ${res.status}). Try again in a moment.`;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup-${backupId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch (error) {
    console.error("CSV export failed:", error);
    return "CSV export failed: network error. Try again in a moment.";
  }
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
// Merchant-facing names for the raw webhook field keys, matching the
// vocabulary the undo modal uses (see SCALAR_LABELS in api.product-history).
const FIELD_LABELS: Record<string, string> = {
  title: "title",
  body_html: "description",
  vendor: "vendor",
  product_type: "product type",
  handle: "handle",
  tags: "tags",
  status: "status",
  template_suffix: "theme template",
  variants: "variant details",
  images: "images",
  options: "options",
  published_at: "publishing",
  metafields: "metafields",
};

function RestoreChanges() {
  const changedFetcher = useFetcher<typeof changedProductsLoader>();
  const hydrated = useHydrated();
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
      // The undo modal already speaks a merchant vocabulary ("Price",
      // "Description"); this list printed the raw webhook keys, so one price
      // edit read as "variants" here and "Price" one click away. "variants"
      // stays deliberately vague — the ledger records that the variant block
      // changed, not which field inside it, so naming "price" here would be a
      // guess. The modal diffs the snapshots and can be specific; this cannot.
      const label = (f: string) => FIELD_LABELS[f] ?? f;
      const changedSummary =
        item.changedFields && item.changedFields.length > 0
          ? `${item.changedFields.slice(0, 3).map(label).join(", ")}${
              item.changedFields.length > 3 ? "…" : ""
            }`
          : "";
      return [
        item.title || "Unknown product",
        [formatDate(item.changedAt, hydrated), changedSummary]
          .filter(Boolean)
          .join(" · "),
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
  const hydrated = useHydrated();
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
      formatDate(item.deletedAt, hydrated),
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

/**
 * "Automatic backups" card. Toggles Store.autoBackupEnabled + the store's
 * BackupSchedule (interval) via the saveSchedule action. The scheduler
 * (scheduler.server.ts cron) picks it up.
 */
function ScheduleCard({
  initialEnabled,
  initialInterval,
  nextRunAt,
  planAllows,
}: {
  initialEnabled: boolean;
  initialInterval: string;
  nextRunAt: string | null;
  planAllows: boolean;
}) {
  const fetcher = useFetcher<{ scheduleSaved?: boolean; error?: string }>();
  const hydrated = useHydrated();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [interval, setIntervalValue] = useState(initialInterval);
  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.scheduleSaved;
  const saveError = fetcher.data?.error;

  const save = () => {
    fetcher.submit(
      { action: "saveSchedule", enabled: String(enabled), interval },
      { method: "POST" },
    );
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Automatic backups
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {!planAllows
              ? "Automatic backups are available on the Standard and Premium plans."
              : initialEnabled && nextRunAt
                ? `Next backup ${formatDate(nextRunAt, hydrated)}.`
                : "Run a backup automatically on a schedule."}
          </Text>
        </BlockStack>
        <Checkbox
          label="Enable automatic backups"
          checked={enabled}
          onChange={setEnabled}
          disabled={!planAllows}
        />
        <InlineStack gap="300" blockAlign="end">
          <Select
            label="Frequency"
            options={[
              { label: "Every 6 hours", value: "EVERY_6H" },
              { label: "Every 12 hours", value: "EVERY_12H" },
              { label: "Daily", value: "DAILY" },
              { label: "Weekly", value: "WEEKLY" },
            ]}
            value={interval}
            onChange={setIntervalValue}
            disabled={!enabled || !planAllows}
          />
          <Button
            onClick={save}
            loading={saving}
            variant="primary"
            disabled={!planAllows}
          >
            Save
          </Button>
          {saved ? <Badge tone="success">Saved</Badge> : null}
        </InlineStack>
        {saveError ? (
          <Text as="p" variant="bodySm" tone="critical">
            {saveError}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

export default function Index() {
  const { store, backups, totalBackups, lastBackup, schedule, showDevTools } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const hydrated = useHydrated();
  const [csvError, setCsvError] = useState<string | null>(null);

  // A backup currently queued or running. Manual backups now start in the
  // background as PENDING (startBackupIfIdle), so count those too.
  const activeBackup = backups.find(
    (b) => b.status === "IN_PROGRESS" || b.status === "PENDING",
  );
  const isActive = Boolean(activeBackup);
  const isBackingUp = navigation.state === "submitting" || isActive;

  // Backup-start failure (e.g. one already running) from the action.
  // ("error" only exists on failure responses, and `in` narrows the union.)
  const backupError =
    actionData && "error" in actionData ? actionData.error : null;

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
    formatDate(backup.createdAt, hydrated),
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
      <InlineStack key={`a-${backup.id}`} gap="200">
        <Button
          size="slim"
          onClick={() => navigate(`/app/backups/${backup.id}`)}
        >
          Restore
        </Button>
        <Button
          size="slim"
          onClick={() => {
            void downloadCsv(backup.id).then(setCsvError);
          }}
        >
          CSV
        </Button>
      </InlineStack>
    ) : (
      ""
    ),
  ]);

  return (
    <Page>
      <TitleBar title="Store Backup">
        {showDevTools ? (
          <button onClick={() => navigate("/app/reset")}>Reset data</button>
        ) : null}
      </TitleBar>
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

        {/* Backup couldn't start (e.g. one is already running) */}
        {backupError && (
          <Banner title="Backup not started" tone="warning">
            <p>{backupError}</p>
          </Banner>
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
                {/* During the post-downgrade grace period the plan and the
                    retention disagree — "Free" next to "90-day retention"
                    reads as a bug unless the deadline is stated. Say when it
                    changes, so the merchant can act while it still matters. */}
                {store?.pendingRetentionDays != null &&
                  store?.pendingRetentionAt != null && (
                    <Text as="p" variant="bodySm" tone="caution">
                      Drops to {store.pendingRetentionDays}-day retention on{" "}
                      {new Date(store.pendingRetentionAt)
                        .toISOString()
                        .slice(0, 10)}
                    </Text>
                  )}
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
                  {lastBackup
                    ? formatDate(lastBackup.createdAt, hydrated)
                    : "Run your first backup"}
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

        {/* Automatic backup schedule */}
        <ScheduleCard
          initialEnabled={store?.autoBackupEnabled ?? false}
          initialInterval={schedule?.interval ?? "DAILY"}
          nextRunAt={schedule?.nextRunAt ?? null}
          planAllows={(store?.plan ?? "FREE") !== "FREE"}
        />

        {/* Backup History */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Backup History
            </Text>
            {csvError && (
              <Banner tone="critical" onDismiss={() => setCsvError(null)}>
                <p>{csvError}</p>
              </Banner>
            )}
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

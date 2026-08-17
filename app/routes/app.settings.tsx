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
  Select,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  authenticate,
  STANDARD_PLAN,
  PREMIUM_PLAN,
  STANDARD_TRIAL_PLAN,
  PREMIUM_TRIAL_PLAN,
  ALL_PLANS,
  tierForPlanName,
} from "../shopify.server";
import {
  TRIAL_DAYS,
  RETENTION_GRACE_DAYS,
  planRetentionDays,
  planRank,
  type PlanId,
} from "../billing";
import prisma from "../db.server";
import { storage } from "../services/storage.server";
import { computeNextRunAt } from "../services/scheduler.server";
import { planTransition, isTestBilling } from "../services/plan.server";

const PLANS = [
  {
    id: "FREE",
    name: "Free",
    price: "$0",
    features: [
      "Manual backups only",
      "Products backup",
      "7-day retention",
    ],
  },
  {
    id: "STANDARD",
    name: "Standard",
    price: "$9/mo",
    features: [
      `${TRIAL_DAYS}-day free trial for new subscribers`,
      "Daily automatic backups",
      "Products, collections, pages, blogs, redirects, menus",
      "30-day retention",
      "One-click product restore",
    ],
  },
  {
    id: "PREMIUM",
    name: "Premium",
    price: "$19/mo",
    features: [
      `${TRIAL_DAYS}-day free trial for new subscribers`,
      "Everything in Standard",
      "Real-time change tracking via webhooks",
      "90-day retention",
      "Change history with changed-field tracking",
      "Restore changed products from the product list",
    ],
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);

  // Ask Shopify what the merchant is actually paying for. This is the source
  // of truth - the DB plan is only a cache that we reconcile here (e.g. after
  // the merchant returns from approving a charge, or after a charge lapses).
  const { appSubscriptions } = await billing.check({
    plans: [...ALL_PLANS],
    isTest: isTestBilling(),
  });

  const activeName = appSubscriptions[0]?.name;
  const actualPlan: PlanId = tierForPlanName(activeName);

  let store = await prisma.store.findUnique({ where: { id: session.shop } });

  // Reconcile the cached plan with reality. This is the path a lapsed
  // subscription takes — the merchant never clicked anything, so the staged
  // shrink in planTransition is what stops it quietly costing them history.
  if (store && store.plan !== actualPlan) {
    store = await prisma.store.update({
      where: { id: session.shop },
      data: planTransition(store, actualPlan),
    });
  }

  // Burn the trial the first time this shop is seen on a paid subscription.
  // Shopify grants trialDays per subscription and never checks whether the
  // shop already had one, so without this a merchant could switch plans (or
  // cancel and resubscribe) for a fresh 14 free days, forever.
  if (store && actualPlan !== "FREE" && !store.trialUsedAt) {
    store = await prisma.store.update({
      where: { id: session.shop },
      data: { trialUsedAt: new Date() },
    });
  }

  return json({
    store:
      store || {
        id: session.shop,
        plan: actualPlan,
        autoBackupEnabled: false,
        autoBackupHour: 3,
        retentionDays: 7,
        pendingRetentionDays: null,
        pendingRetentionAt: null,
        trialUsedAt: null,
      },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "updateSettings") {
    const autoBackupEnabled = formData.get("autoBackupEnabled") === "true";
    const parsedHour = parseInt(formData.get("autoBackupHour") as string, 10);
    // NaN falls back to 3; clamp so a crafted value can't skew nextRunAt.
    const autoBackupHour = Number.isNaN(parsedHour)
      ? 3
      : Math.min(23, Math.max(0, parsedHour));

    // Automatic backups are a paid entitlement — enforce it server-side even
    // though the card is hidden on the Free plan.
    const store = await prisma.store.findUnique({ where: { id: shop } });
    if (autoBackupEnabled && (store?.plan ?? "FREE") === "FREE") {
      return json({
        success: false,
        error: "Automatic backups are available on the Standard and Premium plans.",
      });
    }

    await prisma.store.update({
      where: { id: shop },
      data: { autoBackupEnabled, autoBackupHour },
    });

    // Keep the BackupSchedule row in step with the Store flags — the
    // scheduler only fires stores whose schedule is enabled with a due
    // nextRunAt (mirrors the dashboard's saveSchedule path). Preserve a
    // dashboard-chosen interval; null nextRunAt while disabled.
    const existing = await prisma.backupSchedule.findUnique({
      where: { storeId: shop },
    });
    const interval = existing?.interval ?? "DAILY";
    // Anchor on the stored weeklyDay (timestamps only as a fallback for rows
    // that predate it — the scheduler's failure path reuses nextRunAt as a
    // retry timer) so a WEEKLY schedule keeps its weekday — the merchant is
    // only editing the hour here, not the run day.
    const nextRunAt = autoBackupEnabled
      ? computeNextRunAt(
          interval,
          autoBackupHour,
          new Date(),
          existing?.weeklyDay ?? existing?.nextRunAt ?? existing?.lastRunAt,
        )
      : null;
    // Lock in the WEEKLY run day; undefined leaves the stored value alone
    // (Prisma skips undefined fields).
    const weeklyDay =
      interval === "WEEKLY" && nextRunAt ? nextRunAt.getUTCDay() : undefined;
    await prisma.backupSchedule.upsert({
      where: { storeId: shop },
      create: {
        storeId: shop,
        enabled: autoBackupEnabled,
        interval,
        nextRunAt,
        weeklyDay,
      },
      update: { enabled: autoBackupEnabled, nextRunAt, weeklyDay },
    });

    return json({ success: true });
  }

  if (actionType === "subscribe") {
    const plan = formData.get("plan") as string;

    if (plan === "FREE") {
      // Downgrade: cancel any active subscription, then drop the cached plan.
      const { appSubscriptions } = await billing.check({
        plans: [...ALL_PLANS],
        isTest: isTestBilling(),
      });
      for (const sub of appSubscriptions) {
        await billing.cancel({
          subscriptionId: sub.id,
          isTest: isTestBilling(),
          prorate: true,
        });
      }

      const current = await prisma.store.findUnique({ where: { id: shop } });
      await prisma.store.update({
        where: { id: shop },
        data: planTransition(current, "FREE"),
      });
      return json({ success: true });
    }

    // Paid plan: request payment. billing.request redirects the merchant to
    // Shopify's confirmation page (it throws a redirect response). The DB plan
    // is NOT changed here - it is reconciled in the loader once the merchant
    // returns from approving the charge.
    // Offer the trial variant only to a shop that has not used its trial.
    const storeRow = await prisma.store.findUnique({ where: { id: shop } });
    const withTrial = !storeRow?.trialUsedAt;
    const planName =
      plan === "PREMIUM"
        ? withTrial
          ? PREMIUM_TRIAL_PLAN
          : PREMIUM_PLAN
        : withTrial
          ? STANDARD_TRIAL_PLAN
          : STANDARD_PLAN;
    // Return the merchant INTO the embedded admin, not to the app's own
    // domain. Shopify sends them here in the TOP-LEVEL window after they
    // approve the charge, so a raw app URL lands them outside the admin
    // iframe with no session token — the app then bounces them to
    // /auth/login and asks for a shop domain, stranding them mid-purchase
    // even though the subscription succeeded. The admin deep link re-enters
    // the embedded context, where authenticate.admin can do token exchange.
    const shopHandle = shop.replace(/\.myshopify\.com$/, "");
    const returnUrl =
      `https://admin.shopify.com/store/${shopHandle}` +
      `/apps/${process.env.SHOPIFY_API_KEY}/app/settings`;

    return billing.request({
      plan: planName,
      isTest: isTestBilling(),
      returnUrl,
    });
  }

  if (actionType === "deleteAllBackups") {
    // Remove each backup's blob prefix (`${shop}/${backupId}/...`), then the DB
    // records. BackupItem rows cascade-delete with their parent Backup. Do NOT
    // delete the whole `${shop}/` prefix — it also holds the change-ledger
    // snapshots (`${shop}/changes/...`) and the cost/metafield diff baselines
    // (`${shop}/state/...`) that the undo timeline depends on.
    const backups = await prisma.backup.findMany({
      where: { storeId: shop },
      select: { id: true },
    });
    for (const backup of backups) {
      await storage.deletePrefix(`${shop}/${backup.id}/`);
    }
    await prisma.backup.deleteMany({ where: { storeId: shop } });

    return json({ success: true });
  }

  return json({ success: false, error: "Unknown action" });
};

export default function Settings() {
  const { store } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [autoBackupEnabled, setAutoBackupEnabled] = useState(store.autoBackupEnabled);
  const [autoBackupHour, setAutoBackupHour] = useState(String(store.autoBackupHour));

  const handleSaveSettings = () => {
    submit(
      {
        action: "updateSettings",
        autoBackupEnabled: String(autoBackupEnabled),
        autoBackupHour,
      },
      { method: "POST" },
    );
  };

  const handleSubscribe = (plan: string) => {
    // Downgrading is as destructive as "Delete All Backups" below, just on a
    // delay — say so before it happens, and name the deadline. Any drop in
    // rank counts, not just a drop to Free: Premium -> Standard shrinks
    // retention 90 -> 30 days and silently expires 60 days of history.
    if (planRank(plan as PlanId) < planRank(store.plan as PlanId)) {
      const current = planRetentionDays(store.plan as PlanId);
      const after = planRetentionDays(plan as PlanId);
      if (
        !window.confirm(
          `Downgrade to Free?\n\n` +
            `Automatic backups stop right away.\n\n` +
            `Your backup history stays at ${current} days for another ` +
            `${RETENTION_GRACE_DAYS} days. After that, backups older than ` +
            `${after} days are permanently deleted and cannot be recovered.\n\n` +
            `Resubscribing before then keeps everything.`,
        )
      ) {
        return;
      }
    }
    submit({ action: "subscribe", plan }, { method: "POST" });
  };

  // Server sends Dates as ISO strings through json().
  const pendingAt = store.pendingRetentionAt
    ? new Date(store.pendingRetentionAt)
    : null;

  const handleDeleteAllBackups = () => {
    if (
      !window.confirm(
        "Delete ALL backups for this store? This is irreversible and removes every stored backup file and record.",
      )
    ) {
      return;
    }
    submit({ action: "deleteAllBackups" }, { method: "POST" });
  };

  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    label: `${i.toString().padStart(2, "0")}:00 UTC`,
    value: String(i),
  }));

  return (
    <Page title="Settings">
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        {/* A retention shrink is staged — the merchant still has time to act */}
        {pendingAt && store.pendingRetentionDays !== null && (
          <Banner
            title="Your backup history is scheduled to shrink"
            tone="warning"
            action={{ content: "See plans", url: "/app/settings" }}
          >
            <p>
              Backups are still kept for {store.retentionDays} days. On{" "}
              {pendingAt.toISOString().slice(0, 10)} this drops to{" "}
              {store.pendingRetentionDays} days, and older backups are
              permanently deleted. Resubscribe before then to keep them.
            </p>
          </Banner>
        )}

        {/* Plans */}
        <Text as="h2" variant="headingLg">Plans</Text>
        <Layout>
          {PLANS.map((plan) => (
            <Layout.Section key={plan.id} variant="oneThird">
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingMd">{plan.name}</Text>
                    <Text as="p" variant="headingLg">{plan.price}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    {plan.features.map((feature) => (
                      <Text key={feature} as="p" variant="bodySm">
                        {feature}
                      </Text>
                    ))}
                  </BlockStack>
                  {store.plan === plan.id ? (
                    <Button disabled>Current Plan</Button>
                  ) : (
                    <Button
                      variant={plan.id === "PREMIUM" ? "primary" : undefined}
                      onClick={() => handleSubscribe(plan.id)}
                      loading={isSaving}
                    >
                      {planRank(plan.id as PlanId) <
                      planRank(store.plan as PlanId)
                        ? "Downgrade"
                        : store.plan === "FREE"
                          ? "Start free trial"
                          : "Upgrade"}
                    </Button>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          ))}
        </Layout>

        {/* Auto-Backup Settings */}
        {store.plan !== "FREE" && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Auto-Backup Settings</Text>
              <Checkbox
                label="Enable daily automatic backups"
                checked={autoBackupEnabled}
                onChange={setAutoBackupEnabled}
              />
              {autoBackupEnabled && (
                <Select
                  label="Backup time (UTC)"
                  options={hourOptions}
                  value={autoBackupHour}
                  onChange={setAutoBackupHour}
                />
              )}
              <InlineStack>
                <Button onClick={handleSaveSettings} loading={isSaving}>
                  Save Settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* Danger Zone */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd" tone="critical">Danger Zone</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Deleting all backups is irreversible.
            </Text>
            <InlineStack>
              <Button
                tone="critical"
                onClick={handleDeleteAllBackups}
                loading={isSaving}
              >
                Delete All Backups
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

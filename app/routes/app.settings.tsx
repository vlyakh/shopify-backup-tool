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
} from "@shopify/polaris";
import { useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, STANDARD_PLAN, PREMIUM_PLAN } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

const IS_TEST_BILLING = process.env.NODE_ENV !== "production";

// Map an active Shopify subscription plan name to our stored plan settings.
function planSettings(plan: "FREE" | "STANDARD" | "PREMIUM") {
  switch (plan) {
    case "PREMIUM":
      return { plan, retentionDays: 90, webhooksEnabled: true };
    case "STANDARD":
      return { plan, retentionDays: 30, webhooksEnabled: false };
    default:
      return { plan, retentionDays: 7, webhooksEnabled: false, autoBackupEnabled: false };
  }
}

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
    plans: [STANDARD_PLAN, PREMIUM_PLAN],
    isTest: IS_TEST_BILLING,
  });

  const activeName = appSubscriptions[0]?.name;
  const actualPlan: "FREE" | "STANDARD" | "PREMIUM" =
    activeName === PREMIUM_PLAN
      ? "PREMIUM"
      : activeName === STANDARD_PLAN
        ? "STANDARD"
        : "FREE";

  let store = await prisma.store.findUnique({ where: { id: session.shop } });

  // Reconcile the cached plan with reality.
  if (store && store.plan !== actualPlan) {
    store = await prisma.store.update({
      where: { id: session.shop },
      data: planSettings(actualPlan),
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
    const autoBackupHour = parseInt(formData.get("autoBackupHour") as string) || 3;

    await prisma.store.update({
      where: { id: shop },
      data: { autoBackupEnabled, autoBackupHour },
    });

    return json({ success: true });
  }

  if (actionType === "subscribe") {
    const plan = formData.get("plan") as string;

    if (plan === "FREE") {
      // Downgrade: cancel any active subscription, then drop the cached plan.
      const { appSubscriptions } = await billing.check({
        plans: [STANDARD_PLAN, PREMIUM_PLAN],
        isTest: IS_TEST_BILLING,
      });
      for (const sub of appSubscriptions) {
        await billing.cancel({
          subscriptionId: sub.id,
          isTest: IS_TEST_BILLING,
          prorate: true,
        });
      }

      await prisma.store.update({
        where: { id: shop },
        data: planSettings("FREE"),
      });
      return json({ success: true });
    }

    // Paid plan: request payment. billing.request redirects the merchant to
    // Shopify's confirmation page (it throws a redirect response). The DB plan
    // is NOT changed here - it is reconciled in the loader once the merchant
    // returns from approving the charge.
    const planName = plan === "PREMIUM" ? PREMIUM_PLAN : STANDARD_PLAN;
    const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/settings`;

    return billing.request({
      plan: planName,
      isTest: IS_TEST_BILLING,
      returnUrl,
    });
  }

  if (actionType === "deleteAllBackups") {
    // Remove every stored backup file for this shop, then the DB records.
    // BackupItem rows cascade-delete with their parent Backup.
    await storage.deletePrefix(`${shop}/`);
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
    submit({ action: "subscribe", plan }, { method: "POST" });
  };

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
                      {plan.id === "FREE" ? "Downgrade" : "Upgrade"}
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

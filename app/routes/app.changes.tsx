import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Badge,
  DataTable,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const store = await prisma.store.findUnique({ where: { id: shop } });

  const changes = await prisma.changeLog.findMany({
    where: { storeId: shop },
    orderBy: { changedAt: "desc" },
    take: 100,
  });

  return json({
    isPremium: store?.plan === "PREMIUM",
    changes: changes.map((c) => ({
      id: c.id,
      resourceType: c.resourceType,
      resourceId: c.resourceId,
      action: c.action,
      changedAt: c.changedAt.toISOString(),
      changedFields: c.changedFields,
    })),
  });
};

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActionBadge({ action }: { action: string }) {
  const config: Record<string, { tone: "success" | "attention" | "critical"; label: string }> = {
    CREATED: { tone: "success", label: "Created" },
    UPDATED: { tone: "attention", label: "Updated" },
    DELETED: { tone: "critical", label: "Deleted" },
  };
  const c = config[action] || { tone: "attention" as const, label: action };
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

export default function Changes() {
  const { isPremium, changes } = useLoaderData<typeof loader>();

  if (!isPremium) {
    return (
      <Page title="Change History">
        <TitleBar title="Change History" />
        <Banner
          title="Premium feature"
          tone="info"
          action={{ content: "Upgrade", url: "/app/settings" }}
        >
          <p>
            Real-time change tracking is available on the Premium plan ($19/mo).
            Get notified when products, collections, or other resources are modified,
            with a full history of changes and the ability to restore previous versions.
          </p>
        </Banner>
      </Page>
    );
  }

  const rows = changes.map((change) => [
    formatDate(change.changedAt),
    <ActionBadge key={change.id} action={change.action} />,
    <Badge key={`type-${change.id}`}>{change.resourceType}</Badge>,
    change.resourceId.replace("gid://shopify/", ""),
    change.changedFields.length > 0
      ? change.changedFields.slice(0, 3).join(", ") +
        (change.changedFields.length > 3 ? ` +${change.changedFields.length - 3} more` : "")
      : "-",
  ]);

  return (
    <Page title="Change History">
      <TitleBar title="Change History" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Recent Changes ({changes.length})
            </Text>
            {changes.length === 0 ? (
              <EmptyState
                heading="No changes tracked yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Changes to your products and collections will appear here in real-time.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["When", "Action", "Type", "Resource", "Changed Fields"]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

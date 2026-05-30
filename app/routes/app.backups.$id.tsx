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
  Badge,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { restoreItems } from "../services/restore.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const backupId = params.id!;

  const backup = await prisma.backup.findFirst({
    where: { id: backupId, storeId: session.shop },
    include: {
      items: {
        orderBy: [{ resourceType: "asc" }, { title: "asc" }],
      },
    },
  });

  if (!backup) {
    throw new Response("Backup not found", { status: 404 });
  }

  return json({
    backup: {
      id: backup.id,
      status: backup.status,
      trigger: backup.trigger,
      createdAt: backup.createdAt.toISOString(),
      productCount: backup.productCount,
      collectionCount: backup.collectionCount,
      pageCount: backup.pageCount,
      blogPostCount: backup.blogPostCount,
      redirectCount: backup.redirectCount,
      errorMessage: backup.errorMessage,
    },
    items: backup.items.map((item) => ({
      id: item.id,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      title: item.title || item.resourceId,
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

    const results = await restoreItems(admin, itemIds, rest);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return json({
      success: true,
      results: { succeeded, failed, details: results },
    });
  }

  return json({ success: false, error: "Unknown action" });
};

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("en-US", {
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

export default function BackupDetail() {
  const { backup, items } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isRestoring = navigation.state === "submitting";

  const handleRestoreAll = () => {
    const formData = new FormData();
    formData.set("action", "restore");
    items.forEach((item) => formData.append("itemId", item.id));
    submit(formData, { method: "POST" });
  };

  const handleRestoreItem = (itemId: string) => {
    const formData = new FormData();
    formData.set("action", "restore");
    formData.append("itemId", itemId);
    submit(formData, { method: "POST" });
  };

  const rows = items.map((item) => [
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
      title={`Backup - ${formatDate(backup.createdAt)}`}
      backAction={{ content: "Backups", url: "/app" }}
      primaryAction={{
        content: isRestoring ? "Restoring..." : "Restore All",
        onAction: handleRestoreAll,
        loading: isRestoring,
        disabled: isRestoring || items.length === 0,
      }}
    >
      <BlockStack gap="500">
        {backup.errorMessage && (
          <Banner title="Backup had errors" tone="critical">
            <p>{backup.errorMessage}</p>
          </Banner>
        )}

        {/* Summary */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Products</Text>
                <Text as="p" variant="headingLg">{backup.productCount}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Collections</Text>
                <Text as="p" variant="headingLg">{backup.collectionCount}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Pages & Posts</Text>
                <Text as="p" variant="headingLg">
                  {backup.pageCount + backup.blogPostCount}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Items Table */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Backed Up Items ({items.length})
              </Text>
            </InlineStack>
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Type", "Name", "Action"]}
              rows={rows}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Divider,
} from "@shopify/ui-extensions-react/admin";

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 30) return `${diffDays}d`;
  return date.toLocaleDateString();
}

function BackupStatusBlock() {
  const { data, navigation } = useApi();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const productId = data.selected?.[0]?.id;

  useEffect(() => {
    if (!productId) return;

    async function fetchStatus() {
      try {
        const response = await fetch(`/api/backup-status?resourceId=${encodeURIComponent(productId)}`);
        if (response.ok) {
          const result = await response.json();
          setStatus(result);
        }
      } catch (error) {
        console.error("Failed to fetch backup status:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
  }, [productId]);

  if (loading) {
    return (
      <AdminBlock title="Backup Status">
        <Text>Loading...</Text>
      </AdminBlock>
    );
  }

  const isProtected = status?.lastBackedUp != null;
  const changeCount = status?.recentChanges || 0;

  return (
    <AdminBlock title="Backup Status">
      <BlockStack gap="small">
        <InlineStack gap="small" blockAlignment="center">
          <Badge tone={isProtected ? "success" : "warning"}>
            {isProtected ? "Protected" : "Not Protected"}
          </Badge>
          {isProtected && (
            <Text appearance="subdued" size="small">
              Last backup: {formatTimeAgo(status.lastBackedUp)}
            </Text>
          )}
        </InlineStack>

        {changeCount > 0 && (
          <Text appearance="subdued" size="small">
            {changeCount} change{changeCount !== 1 ? "s" : ""} since last backup
          </Text>
        )}

        {!isProtected && (
          <Text appearance="subdued" size="small">
            This product has not been backed up yet. Run a backup from the app to protect it.
          </Text>
        )}

        <Divider />

        <Button
          onPress={() => navigation.navigate("app:backups")}
        >
          View Backups
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <BackupStatusBlock />
));

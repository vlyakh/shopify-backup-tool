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
  const { data } = useApi();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const productId = data.selected?.[0]?.id;

  async function fetchStatus() {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(`/api/backup-status?resourceId=${encodeURIComponent(productId)}`);
      if (!response.ok) {
        throw new Error(`Status request failed (${response.status})`);
      }
      const result = await response.json();
      setStatus(result);
    } catch (error) {
      console.error("Failed to fetch backup status:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!productId) return;
    fetchStatus();
  }, [productId]);

  if (loading) {
    return (
      <AdminBlock title="Backup Status">
        <Text>Loading...</Text>
      </AdminBlock>
    );
  }

  // A failed request is NOT "not protected" — never show the warning state
  // for a backend/network error.
  if (loadError) {
    return (
      <AdminBlock title="Backup Status">
        <BlockStack gap="small">
          <Text>
            Couldn't load the backup status — this does not mean the product
            is unprotected. Check your connection and try again.
          </Text>
          <Button onPress={fetchStatus}>Retry</Button>
        </BlockStack>
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
            <Text>
              Last backup: {formatTimeAgo(status.lastBackedUp)}
            </Text>
          )}
        </InlineStack>

        {changeCount > 0 && (
          <Text>
            {changeCount} change{changeCount !== 1 ? "s" : ""} since last backup
          </Text>
        )}

        {!isProtected && (
          <Text>
            This product has not been backed up yet. Run a backup from the
            Store Backup app to protect it.
          </Text>
        )}
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <BackupStatusBlock />
));

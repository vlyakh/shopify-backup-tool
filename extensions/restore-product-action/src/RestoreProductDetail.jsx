import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  Text,
  Button,
  Badge,
  ProgressIndicator,
} from "@shopify/ui-extensions-react/admin";

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RestoreProductDetail() {
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch(
          `/api/backup-status?resourceId=${encodeURIComponent(productId)}`,
        );
        if (response.ok) {
          setStatus(await response.json());
        }
      } catch (err) {
        console.error("Failed to fetch backup status:", err);
      } finally {
        setLoading(false);
      }
    }
    if (productId) fetchStatus();
    else setLoading(false);
  }, [productId]);

  async function handleRevert() {
    if (!status?.backupItemId) return;
    setRestoring(true);
    setError(null);
    try {
      const response = await fetch("/api/revert-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupItemId: status.backupItemId }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        setDone(
          result.variantWarnings
            ? `Reverted (${result.variantWarnings.length} variant warning${result.variantWarnings.length !== 1 ? "s" : ""})`
            : "Reverted to backup",
        );
      } else {
        setError(result.error || "Revert failed");
      }
    } catch (err) {
      setError("Network error");
    } finally {
      setRestoring(false);
    }
  }

  if (loading) {
    return (
      <AdminAction title="Restore from Backup">
        <BlockStack gap="base">
          <ProgressIndicator size="small" />
          <Text>Checking backups…</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  if (!status?.backupItemId) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <Text>
          No backup found for this product yet. Run a backup from the Store
          Backup app first.
        </Text>
      </AdminAction>
    );
  }

  return (
    <AdminAction
      title="Restore from Backup"
      primaryAction={
        done ? undefined : (
          <Button onPress={handleRevert} disabled={restoring}>
            {restoring ? "Reverting…" : "Revert to backup"}
          </Button>
        )
      }
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        {done ? (
          <Badge tone="success">{done}</Badge>
        ) : (
          <>
            <Text>
              Last backed up{" "}
              {status.lastBackedUp ? formatDate(status.lastBackedUp) : "—"}.
            </Text>
            <Text appearance="subdued" size="small">
              {status.recentChanges > 0
                ? `${status.recentChanges} change${status.recentChanges !== 1 ? "s" : ""} recorded since the backup. `
                : ""}
              Reverting overwrites this product with the backed-up version.
            </Text>
            {error ? (
              <Badge tone="critical">{error}</Badge>
            ) : null}
          </>
        )}
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-details.action.render", () => (
  <RestoreProductDetail />
));

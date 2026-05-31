import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  Text,
  Button,
  Badge,
  Divider,
  ProgressIndicator,
} from "@shopify/ui-extensions-react/admin";

const MAX_FIELDS = 6;

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
  const [diff, setDiff] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchDiff() {
      try {
        const response = await fetch(
          `/api/product-diff?resourceId=${encodeURIComponent(productId)}`,
        );
        if (response.ok) {
          setDiff(await response.json());
        }
      } catch (err) {
        console.error("Failed to fetch product diff:", err);
      } finally {
        setLoading(false);
      }
    }
    if (productId) fetchDiff();
    else setLoading(false);
  }, [productId]);

  async function handleRevert() {
    if (!diff?.backupItemId) return;
    setRestoring(true);
    setError(null);
    try {
      // Admin extensions attach a session-token Authorization header, so this
      // cross-origin POST is always preflighted (OPTIONS) regardless of body.
      // The route's loader answers that preflight — see api.revert-product.tsx.
      // Content-Type is left unset (body stays text/plain) only to keep the
      // preflight's requested headers minimal; request.json() still parses it.
      const response = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId: diff.backupItemId }),
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

  if (!diff?.hasBackup) {
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

  // Backup exists but the live product matches it (also covers deleted:true) —
  // nothing to restore, so no Revert button.
  if (!diff.changed) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>
            This product matches your last backup — nothing to restore.
          </Text>
          {diff.lastBackedUp ? (
            <Text appearance="subdued" size="small">
              Last backed up {formatDate(diff.lastBackedUp)}.
            </Text>
          ) : null}
        </BlockStack>
      </AdminAction>
    );
  }

  const changedFields = diff.changedFields || [];
  const visibleFields = changedFields.slice(0, MAX_FIELDS);
  const hiddenCount = changedFields.length - visibleFields.length;

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
              {diff.lastBackedUp ? formatDate(diff.lastBackedUp) : "—"}.
            </Text>
            <Divider />
            {visibleFields.map((change) => (
              <BlockStack key={change.field} gap="none">
                <Text fontWeight="bold">{change.field}</Text>
                <Text appearance="subdued" size="small">
                  {change.before} {"→"} {change.after}
                </Text>
              </BlockStack>
            ))}
            {hiddenCount > 0 ? (
              <Text appearance="subdued" size="small">
                +{hiddenCount} more
              </Text>
            ) : null}
            <Text appearance="subdued" size="small">
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

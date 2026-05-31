import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Divider,
  ProgressIndicator,
} from "@shopify/ui-extensions-react/admin";

/**
 * "Restore from Backup" action. Same per-change Undo as the block: each change
 * since the last backup is its own revertable row (revert one, keep the rest).
 */
function RestoreProductDetail() {
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState(null);
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});
  const [allPending, setAllPending] = useState(false);

  async function loadDiff() {
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

  useEffect(() => {
    if (productId) loadDiff();
    else setLoading(false);
  }, [productId]);

  async function revertChange(change) {
    setPending((p) => ({ ...p, [change.id]: true }));
    setErrors((p) => ({ ...p, [change.id]: null }));
    try {
      const response = await fetch("/api/revert-product-field", {
        method: "POST",
        body: JSON.stringify({
          backupItemId: diff.backupItemId,
          target: change.target,
        }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        await loadDiff();
      } else {
        setErrors((p) => ({
          ...p,
          [change.id]: result.error || "Revert failed",
        }));
      }
    } catch (err) {
      setErrors((p) => ({ ...p, [change.id]: "Network error" }));
    } finally {
      setPending((p) => ({ ...p, [change.id]: false }));
    }
  }

  async function revertAll() {
    if (!diff?.backupItemId) return;
    setAllPending(true);
    try {
      const response = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId: diff.backupItemId }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        await loadDiff();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setAllPending(false);
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

  const changes = diff.changes || [];
  if (!changes.length) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <Text>This product matches your last backup — nothing to restore.</Text>
      </AdminAction>
    );
  }

  return (
    <AdminAction
      title="Restore from Backup"
      primaryAction={
        <Button onPress={revertAll} disabled={allPending}>
          {allPending ? "Reverting all…" : "Revert all"}
        </Button>
      }
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text>
          Changes since your last backup. Revert any one on its own — the rest
          stay until you revert them.
        </Text>
        <Divider />
        {changes.map((change) => (
          <BlockStack key={change.id} gap="small">
            <InlineStack
              inlineAlignment="space-between"
              blockAlignment="center"
              gap="base"
            >
              <BlockStack gap="none">
                <InlineStack gap="none">
                  <Badge>{change.label}</Badge>
                </InlineStack>
                <Text>
                  {change.before} {"→"} {change.after}
                </Text>
              </BlockStack>
              <Button
                onPress={() => revertChange(change)}
                disabled={pending[change.id]}
              >
                {pending[change.id] ? "Reverting…" : "Revert"}
              </Button>
            </InlineStack>
            {errors[change.id] ? (
              <Badge tone="critical">{errors[change.id]}</Badge>
            ) : null}
          </BlockStack>
        ))}
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-details.action.render", () => (
  <RestoreProductDetail />
));

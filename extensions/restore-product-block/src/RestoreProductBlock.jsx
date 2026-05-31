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

/**
 * "Undo recent changes" block. Lists each change since the last backup as its own
 * revertable row (Title, Price, …) with before → after, so the merchant can undo
 * one change and keep the rest. Reverting refetches the diff, so the reverted row
 * drops off; when nothing is left the block hides itself.
 */
function RestoreProductBlock() {
  const { data } = useApi();
  const productId = data.selected?.[0]?.id;

  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
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
    if (!productId) {
      setLoading(false);
      return;
    }
    loadDiff();
  }, [productId]);

  // Revert a single change back to the backup. No Content-Type header: the
  // session-token Authorization header already preflights this cross-origin POST.
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
        await loadDiff(); // reverted change now matches backup → drops off the list
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

  // Stay invisible until we know there are changes (no flashing card).
  if (loading) {
    return null;
  }
  if (!diff?.hasBackup || diff.changed !== true) {
    return null;
  }

  const changes = diff.changes || [];

  return (
    <AdminBlock title="Undo recent changes">
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
        <Divider />
        <Button onPress={revertAll} disabled={allPending}>
          {allPending ? "Reverting all…" : "Revert all to backup"}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <RestoreProductBlock />
));

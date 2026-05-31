import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  Text,
  Button,
  Badge,
  Divider,
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

function RestoreProductBlock() {
  const { data } = useApi();
  const productId = data.selected?.[0]?.id;

  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!productId) {
      setLoading(false);
      return;
    }

    async function fetchDiff() {
      try {
        // GET diff for the current product. No extra headers needed.
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

    fetchDiff();
  }, [productId]);

  async function handleRevert() {
    if (!diff?.backupItemId) return;
    setReverting(true);
    setError(null);
    try {
      // No Content-Type header on purpose: application/json would trigger a
      // CORS preflight (OPTIONS) that the Remix action doesn't answer. A plain
      // body is a "simple" request; request.json() still parses it server-side.
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
      setReverting(false);
    }
  }

  // A block that hasn't decided yet should not flash a card. Unlike the sibling
  // Backup Status block, the undo card must stay invisible until we know there
  // are changes, so render nothing while loading.
  if (loading) {
    return null;
  }

  // Render the card ONLY when the live product actually differs from the backup.
  // This covers no backup, deleted product, and the unchanged case (changed:false).
  if (!diff?.hasBackup || diff.changed !== true) {
    return null;
  }

  const changedFields = diff.changedFields || [];
  const visibleFields = changedFields.slice(0, MAX_FIELDS);
  const hiddenCount = changedFields.length - visibleFields.length;

  return (
    <AdminBlock title="Undo recent changes">
      <BlockStack gap="small">
        <Text appearance="subdued" size="small">
          This product was changed since your last backup
          {diff.lastBackedUp ? ` (${formatDate(diff.lastBackedUp)})` : ""}.
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

        <Divider />

        {done ? (
          <Badge tone="success">{done}</Badge>
        ) : (
          <BlockStack gap="small">
            <Button onPress={handleRevert} disabled={reverting || !!done}>
              {reverting ? "Reverting…" : "Revert to backup"}
            </Button>
            {error ? <Badge tone="critical">{error}</Badge> : null}
          </BlockStack>
        )}
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <RestoreProductBlock />
));

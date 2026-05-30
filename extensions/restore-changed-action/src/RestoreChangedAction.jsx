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

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RestoreChangedAction() {
  const { close } = useApi();
  const [changedProducts, setChangedProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState({});
  const [reverted, setReverted] = useState({});
  const [errors, setErrors] = useState({});

  useEffect(() => {
    async function fetchChanged() {
      try {
        const response = await fetch("/api/changed-products");
        if (response.ok) {
          const result = await response.json();
          setChangedProducts(result.products || []);
        }
      } catch (error) {
        console.error("Failed to fetch changed products:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchChanged();
  }, []);

  async function handleRevert(backupItemId) {
    setRestoring((prev) => ({ ...prev, [backupItemId]: true }));
    setErrors((prev) => ({ ...prev, [backupItemId]: null }));

    try {
      // No Content-Type header on purpose: application/json would trigger a
      // CORS preflight (OPTIONS) that the Remix action doesn't answer. A plain
      // body is a "simple" request; request.json() still parses it server-side.
      const response = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setReverted((prev) => ({
          ...prev,
          [backupItemId]: result.variantWarnings
            ? `Reverted (${result.variantWarnings.length} variant warning${result.variantWarnings.length !== 1 ? "s" : ""})`
            : "Reverted",
        }));
      } else {
        setErrors((prev) => ({
          ...prev,
          [backupItemId]: result.error || "Revert failed",
        }));
      }
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [backupItemId]: "Network error",
      }));
    } finally {
      setRestoring((prev) => ({ ...prev, [backupItemId]: false }));
    }
  }

  if (loading) {
    return (
      <AdminAction title="Restore Changed Products">
        <BlockStack gap="base">
          <ProgressIndicator size="small" />
          <Text>Checking for changed products...</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  if (changedProducts.length === 0) {
    return (
      <AdminAction
        title="Restore Changed Products"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>All products match your last backup. Nothing to restore.</Text>
          <Text appearance="subdued" size="small">
            Products that have been modified since your last backup will appear
            here. Run backups regularly to keep your data protected.
          </Text>
        </BlockStack>
      </AdminAction>
    );
  }

  return (
    <AdminAction
      title="Restore Changed Products"
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text appearance="subdued" size="small">
          {changedProducts.length} product
          {changedProducts.length !== 1 ? "s" : ""} changed since your last
          backup. Reverting overwrites the product with the backed-up version.
        </Text>
        <Divider />

        {changedProducts.map((product) => (
          <BlockStack key={product.backupItemId} gap="small">
            <InlineStack
              gap="small"
              blockAlignment="center"
              inlineAlignment="space-between"
            >
              <BlockStack gap="none">
                <Text fontWeight="bold">{product.title}</Text>
                <Text appearance="subdued" size="small">
                  Changed {formatDate(product.changedAt)}
                  {product.changeCount > 1
                    ? ` \u00b7 ${product.changeCount} change${product.changeCount !== 1 ? "s" : ""}`
                    : ""}
                  {product.changedFields?.length > 0
                    ? ` \u00b7 ${product.changedFields.slice(0, 3).join(", ")}${product.changedFields.length > 3 ? "..." : ""}`
                    : ""}
                </Text>
              </BlockStack>

              {reverted[product.backupItemId] ? (
                <Badge tone="success">{reverted[product.backupItemId]}</Badge>
              ) : errors[product.backupItemId] ? (
                <BlockStack gap="none">
                  <Badge tone="critical">Failed</Badge>
                  <Text appearance="subdued" size="small">
                    {errors[product.backupItemId]}
                  </Text>
                </BlockStack>
              ) : (
                <Button
                  onPress={() => handleRevert(product.backupItemId)}
                  disabled={restoring[product.backupItemId]}
                >
                  {restoring[product.backupItemId]
                    ? "Reverting..."
                    : "Revert"}
                </Button>
              )}
            </InlineStack>
            <Divider />
          </BlockStack>
        ))}
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-index.action.render", () => (
  <RestoreChangedAction />
));

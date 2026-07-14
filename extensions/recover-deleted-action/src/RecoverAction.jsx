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

function RecoverDeletedAction() {
  const { close } = useApi();
  const [deletedProducts, setDeletedProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [recovering, setRecovering] = useState({});
  const [recovered, setRecovered] = useState({});
  const [errors, setErrors] = useState({});

  async function fetchDeleted() {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/deleted-products");
      if (!response.ok) {
        throw new Error(`Deleted-products request failed (${response.status})`);
      }
      const result = await response.json();
      setDeletedProducts(result.products || []);
    } catch (error) {
      console.error("Failed to fetch deleted products:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDeleted();
  }, []);

  async function handleRecover(backupItemId, productTitle) {
    setRecovering((prev) => ({ ...prev, [backupItemId]: true }));
    setErrors((prev) => ({ ...prev, [backupItemId]: null }));

    try {
      // No Content-Type header on purpose: application/json would trigger a
      // CORS preflight (OPTIONS) that the Remix action doesn't answer. A plain
      // body is a "simple" request; request.json() still parses it server-side.
      const response = await fetch("/api/restore-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setRecovered((prev) => ({ ...prev, [backupItemId]: true }));
      } else {
        console.error("Restore failed:", result);
        setErrors((prev) => ({
          ...prev,
          [backupItemId]: result.error || "Recover failed",
        }));
      }
    } catch (error) {
      console.error("Restore failed:", error);
      setErrors((prev) => ({
        ...prev,
        [backupItemId]: "Network error",
      }));
    } finally {
      setRecovering((prev) => ({ ...prev, [backupItemId]: false }));
    }
  }

  if (loading) {
    return (
      <AdminAction title="Recover Deleted Products">
        <BlockStack gap="base">
          <ProgressIndicator size="small-200" />
          <Text>Loading deleted products...</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  // A failed request must never render the "nothing to recover" empty state.
  if (loadError) {
    return (
      <AdminAction
        title="Recover Deleted Products"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>
            Couldn't load deleted products — this does not mean there is
            nothing to recover. Check your connection and try again.
          </Text>
          <Button onPress={fetchDeleted}>Retry</Button>
        </BlockStack>
      </AdminAction>
    );
  }

  if (deletedProducts.length === 0) {
    return (
      <AdminAction
        title="Recover Deleted Products"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>No recently deleted products found in your backups.</Text>
          <Text>
            Products that were backed up before deletion can be recovered here.
            Make sure you have recent backups enabled.
          </Text>
        </BlockStack>
      </AdminAction>
    );
  }

  return (
    <AdminAction
      title="Recover Deleted Products"
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text>
          {deletedProducts.length} deleted product{deletedProducts.length !== 1 ? "s" : ""} found
          in your backups. Recovered products will be created in Draft status.
        </Text>
        <Divider />

        {deletedProducts.map((product) => (
          <BlockStack key={product.backupItemId} gap="small">
            <InlineStack gap="small" blockAlignment="center" inlineAlignment="space-between">
              <BlockStack gap="none">
                <Text fontWeight="bold">{product.title}</Text>
                <Text>
                  Deleted {formatDate(product.deletedAt)} &middot; {product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}
                </Text>
              </BlockStack>

              {recovered[product.backupItemId] ? (
                <Badge tone="success">Recovered</Badge>
              ) : errors[product.backupItemId] ? (
                <BlockStack gap="none">
                  <Badge tone="critical">Failed</Badge>
                  <Text>{errors[product.backupItemId]}</Text>
                  <Button
                    onPress={() => handleRecover(product.backupItemId, product.title)}
                    disabled={recovering[product.backupItemId]}
                  >
                    {recovering[product.backupItemId] ? "Recovering..." : "Retry"}
                  </Button>
                </BlockStack>
              ) : (
                <Button
                  onPress={() => handleRecover(product.backupItemId, product.title)}
                  disabled={recovering[product.backupItemId]}
                >
                  {recovering[product.backupItemId] ? "Recovering..." : "Recover"}
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
  <RecoverDeletedAction />
));

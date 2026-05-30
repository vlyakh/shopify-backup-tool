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
  const [recovering, setRecovering] = useState({});
  const [recovered, setRecovered] = useState({});

  useEffect(() => {
    async function fetchDeleted() {
      try {
        const response = await fetch("/api/deleted-products");
        if (response.ok) {
          const result = await response.json();
          setDeletedProducts(result.products || []);
        }
      } catch (error) {
        console.error("Failed to fetch deleted products:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchDeleted();
  }, []);

  async function handleRecover(backupItemId, productTitle) {
    setRecovering((prev) => ({ ...prev, [backupItemId]: true }));

    try {
      const response = await fetch("/api/restore-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupItemId }),
      });

      if (response.ok) {
        setRecovered((prev) => ({ ...prev, [backupItemId]: true }));
        setRecovering((prev) => ({ ...prev, [backupItemId]: false }));
      } else {
        const error = await response.json();
        setRecovering((prev) => ({ ...prev, [backupItemId]: false }));
        console.error("Restore failed:", error);
      }
    } catch (error) {
      setRecovering((prev) => ({ ...prev, [backupItemId]: false }));
      console.error("Restore failed:", error);
    }
  }

  if (loading) {
    return (
      <AdminAction title="Recover Deleted Products">
        <BlockStack gap="base">
          <ProgressIndicator size="small" />
          <Text>Loading deleted products...</Text>
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
          <Text appearance="subdued" size="small">
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
        <Text appearance="subdued" size="small">
          {deletedProducts.length} deleted product{deletedProducts.length !== 1 ? "s" : ""} found
          in your backups. Recovered products will be created in Draft status.
        </Text>
        <Divider />

        {deletedProducts.map((product) => (
          <BlockStack key={product.backupItemId} gap="small">
            <InlineStack gap="small" blockAlignment="center" inlineAlignment="space-between">
              <BlockStack gap="none">
                <Text fontWeight="bold">{product.title}</Text>
                <Text appearance="subdued" size="small">
                  Deleted {formatDate(product.deletedAt)} &middot; {product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}
                </Text>
              </BlockStack>

              {recovered[product.backupItemId] ? (
                <Badge tone="success">Recovered</Badge>
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

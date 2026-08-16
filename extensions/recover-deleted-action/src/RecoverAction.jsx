/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RecoverDeletedAction() {
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
      <s-admin-action heading="Recover Deleted Products">
        <s-stack direction="block" gap="base">
          <s-spinner />
          <s-text>Loading deleted products...</s-text>
        </s-stack>
      </s-admin-action>
    );
  }

  // A failed request must never render the "nothing to recover" empty state.
  if (loadError) {
    return (
      <s-admin-action heading="Recover Deleted Products">
        <s-stack direction="block" gap="base">
          <s-text>
            Couldn't load deleted products — this does not mean there is
            nothing to recover. Check your connection and try again.
          </s-text>
          <s-button onClick={fetchDeleted}>Retry</s-button>
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>Close</s-button>
      </s-admin-action>
    );
  }

  if (deletedProducts.length === 0) {
    return (
      <s-admin-action heading="Recover Deleted Products">
        <s-stack direction="block" gap="base">
          <s-text>No recently deleted products found in your backups.</s-text>
          <s-text>
            Products that were backed up before deletion can be recovered here.
            Make sure you have recent backups enabled.
          </s-text>
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>Close</s-button>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading="Recover Deleted Products">
      <s-stack direction="block" gap="base">
        <s-text>
          {deletedProducts.length} deleted product{deletedProducts.length !== 1 ? "s" : ""} found
          in your backups. Recovered products will be created in Draft status.
        </s-text>
        <s-divider />

        {deletedProducts.map((product) => (
          <s-stack key={product.backupItemId} direction="block" gap="small">
            <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
              <s-stack direction="block" gap="none">
                <s-text type="strong">{product.title}</s-text>
                <s-text>
                  Deleted {formatDate(product.deletedAt)} &middot; {product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}
                </s-text>
              </s-stack>

              {recovered[product.backupItemId] ? (
                <s-badge tone="success">Recovered</s-badge>
              ) : errors[product.backupItemId] ? (
                <s-stack direction="block" gap="none">
                  <s-badge tone="critical">Failed</s-badge>
                  <s-text>{errors[product.backupItemId]}</s-text>
                  <s-button
                    onClick={() => handleRecover(product.backupItemId, product.title)}
                    disabled={recovering[product.backupItemId]}
                  >
                    {recovering[product.backupItemId] ? "Recovering..." : "Retry"}
                  </s-button>
                </s-stack>
              ) : (
                <s-button
                  onClick={() => handleRecover(product.backupItemId, product.title)}
                  disabled={recovering[product.backupItemId]}
                >
                  {recovering[product.backupItemId] ? "Recovering..." : "Recover"}
                </s-button>
              )}
            </s-stack>
            <s-divider />
          </s-stack>
        ))}
      </s-stack>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>Close</s-button>
    </s-admin-action>
  );
}

export default () => {
  render(<RecoverDeletedAction />, document.body);
};

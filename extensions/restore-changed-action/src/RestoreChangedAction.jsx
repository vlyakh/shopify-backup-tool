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

function RestoreChangedAction() {
  const [changedProducts, setChangedProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [restoring, setRestoring] = useState({});
  const [reverted, setReverted] = useState({});
  const [errors, setErrors] = useState({});

  async function fetchChanged() {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/changed-products");
      if (!response.ok) {
        throw new Error(`Changed-products request failed (${response.status})`);
      }
      const result = await response.json();
      setChangedProducts(result.products || []);
    } catch (error) {
      console.error("Failed to fetch changed products:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchChanged();
  }, []);

  async function handleRevert(backupItemId) {
    setRestoring((prev) => ({ ...prev, [backupItemId]: true }));
    setErrors((prev) => ({ ...prev, [backupItemId]: null }));

    try {
      // Admin extensions attach a session-token Authorization header, so this
      // cross-origin POST is always preflighted (OPTIONS) regardless of body.
      // The route's loader answers that preflight — see api.revert-product.tsx.
      // Content-Type is left unset (body stays text/plain) only to keep the
      // preflight's requested headers minimal; request.json() still parses it.
      const response = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Partial failure: the route reports variant and media steps that
        // failed even though the product-level revert succeeded.
        const warnings = [
          ...(result.variantWarnings || []),
          ...(result.mediaWarnings || []),
        ];
        setReverted((prev) => ({
          ...prev,
          [backupItemId]: warnings.length
            ? `Reverted (${warnings.length} warning${warnings.length !== 1 ? "s" : ""})`
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
      <s-admin-action heading="Restore Changed Products">
        <s-stack direction="block" gap="base">
          <s-spinner />
          <s-text>Checking for changed products...</s-text>
        </s-stack>
      </s-admin-action>
    );
  }

  // A failed request must never render the reassuring "everything matches"
  // empty state.
  if (loadError) {
    return (
      <s-admin-action heading="Restore Changed Products">
        <s-stack direction="block" gap="base">
          <s-text>
            Couldn't check for changed products — this does not mean everything
            matches your backup. Check your connection and try again.
          </s-text>
          <s-button onClick={fetchChanged}>Retry</s-button>
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  if (changedProducts.length === 0) {
    return (
      <s-admin-action heading="Restore Changed Products">
        <s-stack direction="block" gap="base">
          <s-text>All products match your last backup. Nothing to restore.</s-text>
          <s-text>
            Products that have been modified since your last backup will appear
            here. Run backups regularly to keep your data protected.
          </s-text>
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading="Restore Changed Products">
      <s-stack direction="block" gap="base">
        <s-text>
          {changedProducts.length} product
          {changedProducts.length !== 1 ? "s" : ""} changed since your last
          backup. Reverting overwrites the product with the backed-up version.
        </s-text>
        <s-divider />

        {changedProducts.map((product) => (
          <s-stack key={product.backupItemId} direction="block" gap="small">
            <s-stack
              direction="inline"
              gap="small"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-stack direction="block" gap="none">
                <s-text type="strong">{product.title}</s-text>
                <s-text>
                  Changed {formatDate(product.changedAt)}
                  {product.changeCount > 1
                    ? ` \u00b7 ${product.changeCount} change${product.changeCount !== 1 ? "s" : ""}`
                    : ""}
                  {product.changedFields?.length > 0
                    ? ` \u00b7 ${product.changedFields.slice(0, 3).join(", ")}${product.changedFields.length > 3 ? "..." : ""}`
                    : ""}
                </s-text>
              </s-stack>

              {reverted[product.backupItemId] ? (
                <s-badge
                  tone={
                    reverted[product.backupItemId] === "Reverted"
                      ? "success"
                      : "warning"
                  }
                >
                  {reverted[product.backupItemId]}
                </s-badge>
              ) : errors[product.backupItemId] ? (
                <s-stack direction="block" gap="none">
                  <s-badge tone="critical">Failed</s-badge>
                  <s-text>{errors[product.backupItemId]}</s-text>
                </s-stack>
              ) : (
                <s-button
                  onClick={() => handleRevert(product.backupItemId)}
                  disabled={restoring[product.backupItemId]}
                >
                  {restoring[product.backupItemId]
                    ? "Reverting..."
                    : "Revert"}
                </s-button>
              )}
            </s-stack>
            <s-divider />
          </s-stack>
        ))}
      </s-stack>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Close
      </s-button>
    </s-admin-action>
  );
}

export default () => {
  render(<RestoreChangedAction />, document.body);
};

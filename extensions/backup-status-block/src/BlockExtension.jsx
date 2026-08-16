/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 30) return `${diffDays}d`;
  return date.toLocaleDateString();
}

function BackupStatusBlock() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const productId = shopify.data.selected?.[0]?.id;

  async function fetchStatus() {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(`/api/backup-status?resourceId=${encodeURIComponent(productId)}`);
      if (!response.ok) {
        throw new Error(`Status request failed (${response.status})`);
      }
      const result = await response.json();
      setStatus(result);
    } catch (error) {
      console.error("Failed to fetch backup status:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!productId) return;
    fetchStatus();
  }, [productId]);

  if (loading) {
    return (
      <s-admin-block heading="Backup Status">
        <s-text>Loading...</s-text>
      </s-admin-block>
    );
  }

  // A failed request is NOT "not protected" — never show the warning state
  // for a backend/network error.
  if (loadError) {
    return (
      <s-admin-block heading="Backup Status">
        <s-stack direction="block" gap="small">
          <s-text>
            Couldn't load the backup status — this does not mean the product
            is unprotected. Check your connection and try again.
          </s-text>
          <s-button onClick={fetchStatus}>Retry</s-button>
        </s-stack>
      </s-admin-block>
    );
  }

  const isProtected = status?.lastBackedUp != null;
  const changeCount = status?.recentChanges || 0;

  return (
    <s-admin-block heading="Backup Status">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={isProtected ? "success" : "warning"}>
            {isProtected ? "Protected" : "Not Protected"}
          </s-badge>
          {isProtected && (
            <s-text>
              Last backup: {formatTimeAgo(status.lastBackedUp)}
            </s-text>
          )}
        </s-stack>

        {changeCount > 0 && (
          <s-text>
            {changeCount} change{changeCount !== 1 ? "s" : ""} since last backup
          </s-text>
        )}

        {!isProtected && (
          <s-text>
            This product has not been backed up yet. Run a backup from the
            Store Backup app to protect it.
          </s-text>
        )}
      </s-stack>
    </s-admin-block>
  );
}

export default () => {
  render(<BackupStatusBlock />, document.body);
};

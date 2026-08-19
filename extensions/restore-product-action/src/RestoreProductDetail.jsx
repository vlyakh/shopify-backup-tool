/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "2 hours ago" is what a merchant is actually asking: is this the edit I just
// made, or something older? Beyond a month the relative form stops helping, so
// it falls back to a date.
function formatDate(s) {
  const date = new Date(s);
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupByEvent(rows) {
  const groups = [];
  let cur = null;
  for (const row of rows) {
    if (!cur || cur.changeId !== row.changeId) {
      cur = { changeId: row.changeId, changedAt: row.changedAt, rows: [] };
      groups.push(cur);
    }
    cur.rows.push(row);
  }
  return groups;
}

/**
 * "Undo" action — same change history as the block, grouped by
 * edit, with per-edit Undo.
 */
function RestoreProductDetail() {
  const productId = shopify.data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hist, setHist] = useState(null);
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});
  const [allPending, setAllPending] = useState(false);
  const [allError, setAllError] = useState(null);
  const [allWarnings, setAllWarnings] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);

  async function load() {
    try {
      const r = await fetch(
        `/api/product-history?resourceId=${encodeURIComponent(productId)}`,
      );
      if (!r.ok) throw new Error(`History request failed (${r.status})`);
      setHist(await r.json());
      setLoadError(false);
    } catch (err) {
      console.error("Failed to load history:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (productId) load();
    else setLoading(false);
  }, [productId]);

  // A row Undo and "Revert all" must never run at the same time: the slower
  // write would land after the other's, diverging the product from the ledger.
  const anyRowPending = Object.values(pending).some(Boolean);

  async function undo(row) {
    if (allPending) return;
    const key = `${row.changeId}:${row.field}`;
    setPending((p) => ({ ...p, [key]: true }));
    setErrors((p) => ({ ...p, [key]: null }));
    try {
      const r = await fetch("/api/revert-product-field", {
        method: "POST",
        body: JSON.stringify({ changeId: row.changeId, field: row.field }),
      });
      const result = await r.json();
      if (r.ok && result.success) {
        await load();
      } else {
        setErrors((p) => ({ ...p, [key]: result.error || "Undo failed" }));
      }
    } catch (err) {
      setErrors((p) => ({ ...p, [key]: "Network error" }));
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  }

  async function revertAll() {
    if (!hist?.backupItemId || allPending || anyRowPending) return;
    setAllPending(true);
    setAllError(null);
    setAllWarnings(null);
    try {
      const r = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId: hist.backupItemId }),
      });
      const result = await r.json();
      if (r.ok && result.success) {
        // Partial failure: variant/media steps can fail even though the
        // product-level revert succeeded (and the history is cleared).
        const warnings = [
          ...(result.variantWarnings || []),
          ...(result.mediaWarnings || []),
        ];
        if (warnings.length > 0) setAllWarnings(warnings);
        await load();
      } else {
        setAllError(result.error || "Revert failed");
      }
    } catch (err) {
      console.error(err);
      setAllError("Network error — the revert may not have completed");
    } finally {
      setAllPending(false);
    }
  }

  if (loading) {
    return (
      <s-admin-action heading="Undo">
        <s-stack direction="block" gap="base">
          <s-spinner />
          <s-text>Checking history…</s-text>
        </s-stack>
      </s-admin-action>
    );
  }

  // A failed history request must not render the "no backup" state below.
  if (loadError) {
    return (
      <s-admin-action heading="Undo">
        <s-stack direction="block" gap="base">
          <s-text>
            Couldn't load the change history — this does not mean there is no
            backup. Check your connection and try again.
          </s-text>
          <s-button
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            Retry
          </s-button>
        </s-stack>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  if (!hist?.hasBackup) {
    return (
      <s-admin-action heading="Undo">
        <s-text>
          No backup found for this product yet. Run a backup from the Store
          Backup app first.
        </s-text>
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  const revertAllStatus =
    allError || allWarnings ? (
      <s-stack direction="block" gap="small">
        {allError ? (
          <s-stack direction="block" gap="none">
            <s-badge tone="critical">Revert failed</s-badge>
            <s-text>{allError}</s-text>
          </s-stack>
        ) : null}
        {allWarnings ? (
          <s-stack direction="block" gap="none">
            <s-badge tone="warning">Reverted with warnings</s-badge>
            <s-text>Some parts of this product could not be reverted:</s-text>
            {allWarnings.map((w, i) => (
              <s-text key={i}>{w}</s-text>
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    ) : null;

  const rows = hist.rows || [];
  if (rows.length === 0) {
    // After a revert-all the history is cleared even when some steps failed —
    // keep showing that outcome instead of the clean "no changes" copy.
    return (
      <s-admin-action heading="Undo">
        {revertAllStatus || <s-text>No changes since your last backup.</s-text>}
        <s-button slot="secondary-actions" onClick={() => shopify.close()}>
          Close
        </s-button>
      </s-admin-action>
    );
  }

  const groups = groupByEvent(rows);

  return (
    <s-admin-action heading="Undo">
      <s-stack direction="block" gap="base">
        {revertAllStatus}
        <s-text>
          Every change since your last backup. Undo any one on its own.
        </s-text>
        {groups.map((g) => (
          <s-section key={g.changeId} heading={formatDate(g.changedAt)}>
            <s-stack direction="block" gap="base">
              {g.rows.map((row) => {
                const key = `${row.changeId}:${row.field}`;
                return (
                  <s-stack key={key} direction="block" gap="none">
                    <s-stack
                      direction="inline"
                      justifyContent="space-between"
                      alignItems="center"
                      gap="base"
                    >
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-badge>{row.label}</s-badge>
                        {row.change === "added" ? (
                          <s-badge tone="success">Added</s-badge>
                        ) : row.change === "removed" ? (
                          <s-badge tone="critical">Removed</s-badge>
                        ) : null}
                        <s-text>{row.text}</s-text>
                      </s-stack>
                      {row.revertable ? (
                        <s-button
                          onClick={() => undo(row)}
                          disabled={pending[key] || allPending}
                        >
                          {pending[key] ? "Undoing…" : "Undo"}
                        </s-button>
                      ) : null}
                    </s-stack>
                    {errors[key] ? (
                      <s-badge tone="critical">{errors[key]}</s-badge>
                    ) : null}
                  </s-stack>
                );
              })}
            </s-stack>
          </s-section>
        ))}
        <s-text type="emphasis">
          Showing your recent changes. For anything older, restore a backup from
          the Store Backup app.
        </s-text>
      </s-stack>
      <s-button
        slot="primary-action"
        onClick={() => {
          if (confirmAll) {
            setConfirmAll(false);
            revertAll();
          } else {
            setConfirmAll(true);
          }
        }}
        disabled={allPending || anyRowPending}
      >
        {allPending
          ? "Reverting all…"
          : confirmAll
            ? "Tap again to confirm"
            : "Revert all"}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Close
      </s-button>
    </s-admin-action>
  );
}

export default () => {
  render(<RestoreProductDetail />, document.body);
};

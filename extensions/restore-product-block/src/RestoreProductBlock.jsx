/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

function formatDate(s) {
  return new Date(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Group the flat history rows by ChangeLog event (rows are already ordered
// newest-first and contiguous per event) so each edit is one dated Section.
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
 * "Undo recent changes" — change history since the last backup, grouped by edit.
 * Each row's "Undo" reverts just that field to its value before that edit; the
 * server suppresses the undo's own webhook and hides the row, so the list clears.
 */
function RestoreProductBlock() {
  const productId = shopify.data.selected?.[0]?.id;

  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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
    if (!productId) {
      setLoading(false);
      return;
    }
    load();
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
        await load(); // undone row is now hidden → it drops off the list
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

  if (loading) return null;

  // A failed history request must not silently hide real pending changes.
  if (loadError) {
    return (
      <s-admin-block heading="Undo recent changes">
        <s-stack direction="block" gap="base">
          <s-text>
            Couldn't load the change history — this does not mean there are no
            changes since your last backup. Check your connection and try
            again.
          </s-text>
          <s-button onClick={load}>Retry</s-button>
        </s-stack>
      </s-admin-block>
    );
  }

  const rows = hist?.hasBackup ? hist.rows || [] : [];
  // Keep the block visible after a revert-all failure or partial failure even
  // though the row list is empty — otherwise the outcome would be invisible.
  if (rows.length === 0 && !allError && !allWarnings) return null;

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

  if (rows.length === 0) {
    return (
      <s-admin-block heading="Undo recent changes">
        <s-stack direction="block" gap="base">{revertAllStatus}</s-stack>
      </s-admin-block>
    );
  }

  const groups = groupByEvent(rows);

  return (
    <s-admin-block heading="Undo recent changes">
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
        <s-divider />
        <s-button
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
              ? "Tap again to confirm — overwrites with backup"
              : "Revert all to backup"}
        </s-button>
        <s-text type="emphasis">
          Showing your recent changes. For anything older, restore a backup from
          the Store Backup app.
        </s-text>
      </s-stack>
    </s-admin-block>
  );
}

export default () => {
  render(<RestoreProductBlock />, document.body);
};

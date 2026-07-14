import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Section,
  Text,
  Button,
  Badge,
  Divider,
} from "@shopify/ui-extensions-react/admin";

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
  const { data } = useApi();
  const productId = data.selected?.[0]?.id;

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
      <AdminBlock title="Undo recent changes">
        <BlockStack gap="base">
          <Text>
            Couldn't load the change history — this does not mean there are no
            changes since your last backup. Check your connection and try
            again.
          </Text>
          <Button onPress={load}>Retry</Button>
        </BlockStack>
      </AdminBlock>
    );
  }

  const rows = hist?.hasBackup ? hist.rows || [] : [];
  // Keep the block visible after a revert-all failure or partial failure even
  // though the row list is empty — otherwise the outcome would be invisible.
  if (rows.length === 0 && !allError && !allWarnings) return null;

  const revertAllStatus =
    allError || allWarnings ? (
      <BlockStack gap="small">
        {allError ? (
          <BlockStack gap="none">
            <Badge tone="critical">Revert failed</Badge>
            <Text>{allError}</Text>
          </BlockStack>
        ) : null}
        {allWarnings ? (
          <BlockStack gap="none">
            <Badge tone="warning">Reverted with warnings</Badge>
            <Text>Some parts of this product could not be reverted:</Text>
            {allWarnings.map((w, i) => (
              <Text key={i}>{w}</Text>
            ))}
          </BlockStack>
        ) : null}
      </BlockStack>
    ) : null;

  if (rows.length === 0) {
    return (
      <AdminBlock title="Undo recent changes">
        <BlockStack gap="base">{revertAllStatus}</BlockStack>
      </AdminBlock>
    );
  }

  const groups = groupByEvent(rows);

  return (
    <AdminBlock title="Undo recent changes">
      <BlockStack gap="base">
        {revertAllStatus}
        <Text>
          Every change since your last backup. Undo any one on its own.
        </Text>
        {groups.map((g) => (
          <Section key={g.changeId} heading={formatDate(g.changedAt)}>
            <BlockStack gap="base">
              {g.rows.map((row) => {
                const key = `${row.changeId}:${row.field}`;
                return (
                  <BlockStack key={key} gap="none">
                    <InlineStack
                      inlineAlignment="space-between"
                      blockAlignment="center"
                      gap="base"
                    >
                      <InlineStack gap="small" blockAlignment="center">
                        <Badge>{row.label}</Badge>
                        {row.change === "added" ? (
                          <Badge tone="success">Added</Badge>
                        ) : row.change === "removed" ? (
                          <Badge tone="critical">Removed</Badge>
                        ) : null}
                        <Text>{row.text}</Text>
                      </InlineStack>
                      {row.revertable ? (
                        <Button
                          onPress={() => undo(row)}
                          disabled={pending[key] || allPending}
                        >
                          {pending[key] ? "Undoing…" : "Undo"}
                        </Button>
                      ) : null}
                    </InlineStack>
                    {errors[key] ? (
                      <Badge tone="critical">{errors[key]}</Badge>
                    ) : null}
                  </BlockStack>
                );
              })}
            </BlockStack>
          </Section>
        ))}
        <Divider />
        <Button
          onPress={() => {
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
        </Button>
        <Text fontStyle="italic">
          Showing your recent changes. For anything older, restore a backup from
          the Store Backup app.
        </Text>
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <RestoreProductBlock />
));

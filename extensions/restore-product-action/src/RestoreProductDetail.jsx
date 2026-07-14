import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  InlineStack,
  Section,
  Text,
  Button,
  Badge,
  ProgressIndicator,
} from "@shopify/ui-extensions-react/admin";

function formatDate(s) {
  return new Date(s).toLocaleDateString("en-US", {
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
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

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
      <AdminAction title="Undo">
        <BlockStack gap="base">
          <ProgressIndicator size="small-200" />
          <Text>Checking history…</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  // A failed history request must not render the "no backup" state below.
  if (loadError) {
    return (
      <AdminAction
        title="Undo"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>
            Couldn't load the change history — this does not mean there is no
            backup. Check your connection and try again.
          </Text>
          <Button
            onPress={() => {
              setLoading(true);
              load();
            }}
          >
            Retry
          </Button>
        </BlockStack>
      </AdminAction>
    );
  }

  if (!hist?.hasBackup) {
    return (
      <AdminAction
        title="Undo"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <Text>
          No backup found for this product yet. Run a backup from the Store
          Backup app first.
        </Text>
      </AdminAction>
    );
  }

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

  const rows = hist.rows || [];
  if (rows.length === 0) {
    // After a revert-all the history is cleared even when some steps failed —
    // keep showing that outcome instead of the clean "no changes" copy.
    return (
      <AdminAction
        title="Undo"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        {revertAllStatus || <Text>No changes since your last backup.</Text>}
      </AdminAction>
    );
  }

  const groups = groupByEvent(rows);

  return (
    <AdminAction
      title="Undo"
      primaryAction={
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
              ? "Tap again to confirm"
              : "Revert all"}
        </Button>
      }
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
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
        <Text fontStyle="italic">
          Showing your recent changes. For anything older, restore a backup from
          the Store Backup app.
        </Text>
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-details.action.render", () => (
  <RestoreProductDetail />
));

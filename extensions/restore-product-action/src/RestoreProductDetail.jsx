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
 * "Restore from Backup" action — same change history as the block, grouped by
 * edit, with per-edit Undo.
 */
function RestoreProductDetail() {
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [hist, setHist] = useState(null);
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});
  const [allPending, setAllPending] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  async function load() {
    try {
      const r = await fetch(
        `/api/product-history?resourceId=${encodeURIComponent(productId)}`,
      );
      if (r.ok) setHist(await r.json());
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (productId) load();
    else setLoading(false);
  }, [productId]);

  async function undo(row) {
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
    if (!hist?.backupItemId) return;
    setAllPending(true);
    try {
      const r = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId: hist.backupItemId }),
      });
      const result = await r.json();
      if (r.ok && result.success) await load();
    } catch (err) {
      console.error(err);
    } finally {
      setAllPending(false);
    }
  }

  if (loading) {
    return (
      <AdminAction title="Restore from Backup">
        <BlockStack gap="base">
          <ProgressIndicator size="small" />
          <Text>Checking history…</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  if (!hist?.hasBackup) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <Text>
          No backup found for this product yet. Run a backup from the Store
          Backup app first.
        </Text>
      </AdminAction>
    );
  }

  const rows = hist.rows || [];
  if (rows.length === 0) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <Text>No changes since your last backup.</Text>
      </AdminAction>
    );
  }

  const groups = groupByEvent(rows);

  return (
    <AdminAction
      title="Restore from Backup"
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
          disabled={allPending}
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
                        <Text>{row.text}</Text>
                      </InlineStack>
                      {row.revertable ? (
                        <Button
                          onPress={() => undo(row)}
                          disabled={pending[key]}
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

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
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});
  const [allPending, setAllPending] = useState(false);

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
    if (!productId) {
      setLoading(false);
      return;
    }
    load();
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

  if (loading) return null;
  if (!hist?.hasBackup || !hist.rows || hist.rows.length === 0) return null;

  const groups = groupByEvent(hist.rows);

  return (
    <AdminBlock title="Undo recent changes">
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
                        <Text>
                          {row.before} {"→"} {row.after}
                        </Text>
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
        <Divider />
        <Button onPress={revertAll} disabled={allPending}>
          {allPending ? "Reverting all…" : "Revert all to backup"}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <RestoreProductBlock />
));

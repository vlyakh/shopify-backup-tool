import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
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

/**
 * "Undo recent changes" block — a change HISTORY since the last backup. Each edit
 * is its own row (timestamp + field chip + before → after), so the same field
 * edited twice shows twice. "Undo this edit" sets the field back to what it was
 * immediately before that change; other fields (and other edits) are untouched.
 */
function RestoreProductBlock() {
  const { data } = useApi();
  const productId = data.selected?.[0]?.id;

  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState({});
  const [done, setDone] = useState({});
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
        setDone((p) => ({ ...p, [key]: true }));
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
  // Hide the card unless there's recorded history to act on.
  if (!hist?.hasBackup || !hist.rows || hist.rows.length === 0) return null;

  return (
    <AdminBlock title="Undo recent changes">
      <BlockStack gap="base">
        <Text>
          Every change since your last backup. Undo any one on its own — others
          stay.
        </Text>
        <Divider />
        {hist.rows.map((row, i) => {
          const key = `${row.changeId}:${row.field}`;
          return (
            <BlockStack key={`${key}:${i}`} gap="small">
              <Text fontStyle="italic">{formatDate(row.changedAt)}</Text>
              <InlineStack
                inlineAlignment="space-between"
                blockAlignment="center"
                gap="base"
              >
                <BlockStack gap="none">
                  <InlineStack gap="none">
                    <Badge>{row.label}</Badge>
                  </InlineStack>
                  <Text>
                    {row.before} {"→"} {row.after}
                  </Text>
                </BlockStack>
                {done[key] ? (
                  <Badge tone="success">Undone</Badge>
                ) : row.revertable ? (
                  <Button onPress={() => undo(row)} disabled={pending[key]}>
                    {pending[key] ? "Undoing…" : "Undo"}
                  </Button>
                ) : null}
              </InlineStack>
              {errors[key] ? <Badge tone="critical">{errors[key]}</Badge> : null}
            </BlockStack>
          );
        })}
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

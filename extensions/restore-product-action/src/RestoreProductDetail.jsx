import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Divider,
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

/**
 * "Restore from Backup" action — the same change history as the block: each edit
 * since the last backup, with "Undo this edit" (set the field back to its value
 * just before that change).
 */
function RestoreProductDetail() {
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [hist, setHist] = useState(null);
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

  return (
    <AdminAction
      title="Restore from Backup"
      primaryAction={
        <Button onPress={revertAll} disabled={allPending}>
          {allPending ? "Reverting all…" : "Revert all"}
        </Button>
      }
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text>
          Every change since your last backup. Undo any one on its own — others
          stay.
        </Text>
        <Divider />
        {rows.map((row, i) => {
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
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-details.action.render", () => (
  <RestoreProductDetail />
));

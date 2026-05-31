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
  Divider,
  ProgressIndicator,
} from "@shopify/ui-extensions-react/admin";

const MAX_FIELDS = 6;
const MAX_EVENTS = 8;

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionLabel(action) {
  return action === "CREATED"
    ? "Created"
    : action === "DELETED"
      ? "Deleted"
      : "Updated";
}

function actionTone(action) {
  return action === "DELETED"
    ? "critical"
    : action === "CREATED"
      ? "success"
      : "info";
}

// Lead with what's actually DIFFERENT from the backup right now (with before→after
// values — exactly what Revert undoes), then the ChangeLog history of WHEN each
// change happened (field names).
function buildGroups(diff) {
  const groups = [];
  if (diff.changedFields && diff.changedFields.length) {
    groups.push({
      id: "current",
      heading: "Changed since last backup",
      action: "UPDATED",
      fields: diff.changedFields.map((c) => ({
        field: c.field,
        label: c.label,
        summary: c.summary,
      })),
    });
  }
  if (diff.timeline && diff.timeline.length) {
    for (const event of diff.timeline) groups.push(event);
  }
  return groups;
}

// Newest-first timeline: a timestamp header per event, the action as a badge,
// then each changed field as a labelled badge + readable summary. Never JSON.
function ChangeTimeline({ groups }) {
  return (
    <BlockStack gap="base">
      {groups.slice(0, MAX_EVENTS).map((event) => (
        <Section
          key={event.id}
          heading={
            event.heading ||
            (event.changedAt ? formatDate(event.changedAt) : "Recent changes")
          }
        >
          <BlockStack gap="small">
            <InlineStack gap="small" blockAlignment="center">
              <Badge tone={actionTone(event.action)}>
                {actionLabel(event.action)}
              </Badge>
            </InlineStack>
            {event.fields && event.fields.length ? (
              event.fields.slice(0, MAX_FIELDS).map((f) => (
                <InlineStack key={f.field} gap="small" blockAlignment="baseline">
                  <Badge size="small-100">{f.label || f.field}</Badge>
                  {f.summary ? <Text>{f.summary}</Text> : null}
                </InlineStack>
              ))
            ) : (
              <Text fontStyle="italic">No field-level detail recorded</Text>
            )}
            {event.fields && event.fields.length > MAX_FIELDS ? (
              <Text>+{event.fields.length - MAX_FIELDS} more fields</Text>
            ) : null}
          </BlockStack>
        </Section>
      ))}
      {groups.length > MAX_EVENTS ? (
        <Text>+{groups.length - MAX_EVENTS} earlier changes</Text>
      ) : null}
    </BlockStack>
  );
}

function RestoreProductDetail() {
  const { close, data } = useApi();
  const productId = data?.selected?.[0]?.id;

  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchDiff() {
      try {
        const response = await fetch(
          `/api/product-diff?resourceId=${encodeURIComponent(productId)}`,
        );
        if (response.ok) {
          setDiff(await response.json());
        }
      } catch (err) {
        console.error("Failed to fetch product diff:", err);
      } finally {
        setLoading(false);
      }
    }
    if (productId) fetchDiff();
    else setLoading(false);
  }, [productId]);

  async function handleRevert() {
    if (!diff?.backupItemId) return;
    setRestoring(true);
    setError(null);
    try {
      // Admin extensions attach a session-token Authorization header, so this
      // cross-origin POST is always preflighted (OPTIONS) regardless of body.
      // The route's loader answers that preflight — see api.revert-product.tsx.
      // Content-Type is left unset (body stays text/plain) only to keep the
      // preflight's requested headers minimal; request.json() still parses it.
      const response = await fetch("/api/revert-product", {
        method: "POST",
        body: JSON.stringify({ backupItemId: diff.backupItemId }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        const warns =
          (result.variantWarnings?.length || 0) +
          (result.mediaWarnings?.length || 0);
        setDone(
          warns
            ? `Reverted (${warns} warning${warns !== 1 ? "s" : ""})`
            : "Reverted to backup",
        );
      } else {
        setError(result.error || "Revert failed");
      }
    } catch (err) {
      setError("Network error");
    } finally {
      setRestoring(false);
    }
  }

  if (loading) {
    return (
      <AdminAction title="Restore from Backup">
        <BlockStack gap="base">
          <ProgressIndicator size="small" />
          <Text>Checking backups…</Text>
        </BlockStack>
      </AdminAction>
    );
  }

  if (!diff?.hasBackup) {
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

  // Backup exists but the live product matches it (also covers deleted:true) —
  // nothing to restore, so no Revert button.
  if (!diff.changed) {
    return (
      <AdminAction
        title="Restore from Backup"
        secondaryAction={<Button onPress={close}>Close</Button>}
      >
        <BlockStack gap="base">
          <Text>
            This product matches your last backup — nothing to restore.
          </Text>
          {diff.lastBackedUp ? (
            <Text fontStyle="italic">
              Last backed up {formatDate(diff.lastBackedUp)}.
            </Text>
          ) : null}
        </BlockStack>
      </AdminAction>
    );
  }

  const groups = buildGroups(diff);

  return (
    <AdminAction
      title="Restore from Backup"
      primaryAction={
        done ? undefined : (
          <Button onPress={handleRevert} disabled={restoring}>
            {restoring ? "Reverting…" : "Revert to backup"}
          </Button>
        )
      }
      secondaryAction={<Button onPress={close}>Close</Button>}
    >
      <BlockStack gap="base">
        {done ? (
          <Badge tone="success">{done}</Badge>
        ) : (
          <>
            <Text>
              Last backed up{" "}
              {diff.lastBackedUp ? formatDate(diff.lastBackedUp) : "—"}.
            </Text>
            <Divider />
            <ChangeTimeline groups={groups} />
            <Divider />
            <Text fontStyle="italic">
              Reverting overwrites this product (fields, variants and images)
              with the backed-up version.
            </Text>
            {error ? <Badge tone="critical">{error}</Badge> : null}
          </>
        )}
      </BlockStack>
    </AdminAction>
  );
}

export default reactExtension("admin.product-details.action.render", () => (
  <RestoreProductDetail />
));

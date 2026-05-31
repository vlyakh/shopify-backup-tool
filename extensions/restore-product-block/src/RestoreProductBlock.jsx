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

// Render groups for the timeline: prefer the ChangeLog history (has per-event
// timestamps); otherwise synthesize one group from the current snapshot diff so
// stores without webhooks still get a readable (non-JSON) view.
function buildGroups(diff) {
  if (diff.timeline && diff.timeline.length) return diff.timeline;
  return [
    {
      id: "current",
      changedAt: diff.lastBackedUp,
      action: "UPDATED",
      fields: (diff.changedFields || []).map((c) => ({
        field: c.field,
        label: c.label,
        summary: c.summary,
      })),
    },
  ];
}

// One newest-first timeline of change events: a timestamp header per event, the
// action as a badge, then each changed field as a labelled badge + readable
// summary. Never renders raw JSON. Shared shape across both product popups.
function ChangeTimeline({ groups }) {
  return (
    <BlockStack gap="base">
      {groups.slice(0, MAX_EVENTS).map((event) => (
        <Section
          key={event.id}
          heading={
            event.changedAt ? formatDate(event.changedAt) : "Recent changes"
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

function RestoreProductBlock() {
  const { data } = useApi();
  const productId = data.selected?.[0]?.id;

  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!productId) {
      setLoading(false);
      return;
    }

    async function fetchDiff() {
      try {
        // GET diff for the current product. No extra headers needed.
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

    fetchDiff();
  }, [productId]);

  async function handleRevert() {
    if (!diff?.backupItemId) return;
    setReverting(true);
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
      setReverting(false);
    }
  }

  // A block that hasn't decided yet should not flash a card. Unlike the sibling
  // Backup Status block, the undo card must stay invisible until we know there
  // are changes, so render nothing while loading.
  if (loading) {
    return null;
  }

  // Render the card ONLY when the live product actually differs from the backup.
  // This covers no backup, deleted product, and the unchanged case (changed:false).
  if (!diff?.hasBackup || diff.changed !== true) {
    return null;
  }

  const groups = buildGroups(diff);

  return (
    <AdminBlock title="Undo recent changes">
      <BlockStack gap="base">
        <Text>
          This product changed since your last backup
          {diff.lastBackedUp ? ` (${formatDate(diff.lastBackedUp)})` : ""}.
        </Text>
        <Text fontStyle="italic">
          Reverting restores fields, variants and images to the backup.
        </Text>

        <Divider />

        <ChangeTimeline groups={groups} />

        <Divider />

        {done ? (
          <Badge tone="success">{done}</Badge>
        ) : (
          <BlockStack gap="small">
            <Button onPress={handleRevert} disabled={reverting || !!done}>
              {reverting ? "Reverting…" : "Revert to backup"}
            </Button>
            {error ? <Badge tone="critical">{error}</Badge> : null}
          </BlockStack>
        )}
      </BlockStack>
    </AdminBlock>
  );
}

export default reactExtension("admin.product-details.block.render", () => (
  <RestoreProductBlock />
));

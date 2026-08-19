import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { NOISE_KEYS, FIELD_LABELS } from "../services/noise-fields";

const PAGE_SIZE = 50;


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const store = await prisma.store.findUnique({ where: { id: shop } });
  // Gate on the server, not just in the component below. The loader payload is
  // serialised into the HTML and visible in the network tab, so querying the
  // ledger and then hiding it behind an upsell banner handed the Premium data
  // to every plan. Skip the queries entirely instead.
  const isPremium = store?.plan === "PREMIUM";

  // hidden: false — don't show our own revert echoes as merchant changes
  const where = { storeId: shop, hidden: false };
  const totalChanges = isPremium ? await prisma.changeLog.count({ where }) : 0;
  const totalPages = Math.max(1, Math.ceil(totalChanges / PAGE_SIZE));

  const requestedPage = parseInt(
    new URL(request.url).searchParams.get("page") ?? "1",
    10,
  );
  const page = Math.min(
    Math.max(1, Number.isNaN(requestedPage) ? 1 : requestedPage),
    totalPages,
  );

  const changes = isPremium
    ? await prisma.changeLog.findMany({
        where,
        // id tiebreak keeps pages stable when many rows share a changedAt
        orderBy: [{ changedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      })
    : [];

  // Resolve human titles. The ledger only stores the resource id, so the page
  // showed "Product/15462062522479" — the merchant has no idea which product
  // that is, which makes the most important column of the table useless. The
  // backup items carry the title, so look them up in one query for the page.
  const titles = new Map<string, string>();
  if (changes.length > 0) {
    const items = await prisma.backupItem.findMany({
      where: {
        resourceId: { in: [...new Set(changes.map((c) => c.resourceId))] },
        backup: { storeId: shop },
      },
      select: { resourceId: true, title: true, backup: { select: { createdAt: true } } },
      orderBy: { backup: { createdAt: "desc" } },
    });
    // findMany returns newest first, so the first title wins per resource.
    for (const it of items) {
      if (it.title && !titles.has(it.resourceId)) titles.set(it.resourceId, it.title);
    }
  }

  return json({
    isPremium,
    page,
    totalPages,
    totalChanges,
    changes: changes.map((c) => ({
      id: c.id,
      resourceType: c.resourceType,
      resourceId: c.resourceId,
      title: titles.get(c.resourceId) ?? null,
      action: c.action,
      changedAt: c.changedAt.toISOString(),
      // displayFields is resolved at write time and already merchant-worded
      // ("price", not "variants"). Older rows predate it — fall back to the
      // raw keys, filtered and mapped as before.
      changedFields:
        c.displayFields.length > 0
          ? c.displayFields
          : c.changedFields.filter((f) => !NOISE_KEYS.has(f)),
    })),
  });
};

// The server renders in its own timezone (UTC on Azure) while the browser
// re-renders in the merchant's, so locale formatting during SSR would produce
// hydration text mismatches. Until hydration we render a deterministic,
// labeled UTC string; after mount the merchant-local format takes over.
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

function formatDate(isoString: string, hydrated: boolean): string {
  const date = new Date(isoString);
  // Server renders in UTC, the browser in the merchant's zone, so a locale
  // string during SSR would mismatch on hydration. Deterministic until mount.
  if (!hydrated) {
    const iso = date.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }

  // "2 hours ago" answers the question a merchant is actually asking — is this
  // the edit I just made, or something from last week? An absolute timestamp
  // makes them do that arithmetic themselves. Older entries fall back to a
  // date, where "31 days ago" stops being useful.
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

function ActionBadge({ action }: { action: string }) {
  const config: Record<string, { tone: "success" | "attention" | "critical"; label: string }> = {
    CREATED: { tone: "success", label: "Created" },
    UPDATED: { tone: "attention", label: "Updated" },
    DELETED: { tone: "critical", label: "Deleted" },
  };
  const c = config[action] || { tone: "attention" as const, label: action };
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

export default function Changes() {
  const { isPremium, changes, page, totalPages, totalChanges } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const hydrated = useHydrated();

  if (!isPremium) {
    return (
      <Page title="Change History">
        <TitleBar title="Change History" />
        <Banner
          title="Premium feature"
          tone="info"
          action={{ content: "Upgrade", url: "/app/settings" }}
        >
          <p>
            Real-time change tracking is available on the Premium plan ($19/mo).
            Get notified when products, collections, or other resources are modified,
            with a full history of changes and the ability to restore previous versions.
          </p>
        </Banner>
      </Page>
    );
  }

  const rows = changes.map((change) => [
    formatDate(change.changedAt, hydrated),
    <ActionBadge key={change.id} action={change.action} />,
    <Badge key={`type-${change.id}`}>{change.resourceType}</Badge>,
    change.title ?? change.resourceId.replace("gid://shopify/", ""),
    change.changedFields.length > 0
      ? change.changedFields
          .slice(0, 3)
          .map((f) => FIELD_LABELS[f] ?? f)
          .join(", ") +
        (change.changedFields.length > 3 ? ` +${change.changedFields.length - 3} more` : "")
      : "-",
  ]);

  return (
    <Page title="Change History">
      <TitleBar title="Change History" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Recent Changes ({totalChanges})
            </Text>
            {totalChanges === 0 ? (
              <EmptyState
                heading="No changes tracked yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Changes to your products and collections will appear here in real-time.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="300">
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["When", "Action", "Type", "Resource", "Changed Fields"]}
                  rows={rows}
                />
                {totalPages > 1 && (
                  <InlineStack align="center">
                    <Pagination
                      label={`Page ${page} of ${totalPages}`}
                      hasPrevious={page > 1}
                      onPrevious={() => setSearchParams({ page: String(page - 1) })}
                      hasNext={page < totalPages}
                      onNext={() => setSearchParams({ page: String(page + 1) })}
                    />
                  </InlineStack>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

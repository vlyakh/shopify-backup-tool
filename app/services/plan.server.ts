import {
  RETENTION_GRACE_DAYS,
  planRetentionDays,
  planRank,
  type PlanId,
} from "../billing";
import { tierForPlanName } from "../shopify.server";

/** The shape of `admin` these helpers need — just a GraphQL caller. */
type AdminLike = { graphql: (query: string) => Promise<Response> };

/**
 * Whether to create TEST charges (Shopify records the subscription but no
 * money moves) instead of real ones.
 *
 * Defaults to NODE_ENV, but is overridable, because the two are not the same
 * question. Both deployments run NODE_ENV=production — dev included, since its
 * bundle is built as production and its devDependencies are pruned — so
 * NODE_ENV alone can never say "this is a throwaway test charge". And the
 * Billing API is unavailable to non-public apps, so billing can only ever be
 * exercised against a public app, which is the production one.
 *
 * Set SHOPIFY_BILLING_TEST=true to force test charges while verifying the
 * billing flow, then REMOVE IT. Leaving it on means every merchant subscribes
 * for free — hence the startup warning below, which is deliberately loud.
 */
export function isTestBilling(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV !== "production";
}

const SHOP_PLAN_QUERY = `#graphql
  query ShopPlanForBilling {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }
`;

// Whether a shop is a Partner development store, remembered per shop so the
// billing pages don't pay for the query on every load. A store's dev-ness
// never flips back and forth in practice; the TTL just bounds staleness after
// a dev store is transferred to a merchant.
const DEV_STORE_TTL_MS = 6 * 60 * 60 * 1000;
const devStoreCache = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Per-shop test-charge decision.
 *
 * The global isTestBilling() override still wins when set. Otherwise, a
 * Partner DEVELOPMENT store always gets test charges: since 2026-04-28 Shopify
 * demands a payment method for a real (`test: false`) charge on a dev store —
 * the "You don't have any payment methods on file" wall — and a dev store can
 * never be a paying customer anyway. That is what lets the App Store reviewer
 * (and our own dev store) subscribe to Premium against production without
 * flipping SHOPIFY_BILLING_TEST for every merchant. Real stores get real
 * charges. Falls back to the global setting if the shop query fails.
 */
export async function isTestBillingFor(
  admin: AdminLike,
  shop: string,
): Promise<boolean> {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override === "true" || override === "false") return isTestBilling();

  const cached = devStoreCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.value || isTestBilling();

  try {
    const json = await (await admin.graphql(SHOP_PLAN_QUERY)).json();
    // A GraphQL-level error does not throw — it comes back as `errors` with a
    // null `data`. Reading straight through that would silently decide "not a
    // dev store" and, worse, cache that decision for six hours.
    if (json.errors?.length || !json.data?.shop?.plan) {
      throw new Error(
        json.errors?.[0]?.message ?? "no shop.plan in the response",
      );
    }
    const isDev = json.data.shop.plan.partnerDevelopment === true;
    devStoreCache.set(shop, { value: isDev, expiresAt: Date.now() + DEV_STORE_TTL_MS });
    console.log(
      `[Billing] ${shop}: partnerDevelopment=${isDev}, charges are ${
        isDev || isTestBilling() ? "TEST" : "real"
      }`,
    );
    return isDev || isTestBilling();
  } catch (error) {
    console.warn(
      `[Billing] Could not read shop plan for ${shop}; using global test-billing setting: ${error instanceof Error ? error.message : String(error)}`,
    );
    return isTestBilling();
  }
}

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
      }
    }
  }
`;

export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
};

/**
 * What Shopify is actually charging this shop for, read from
 * currentAppInstallation.
 *
 * This replaces billing.check() as the source of truth, for one reason: the
 * library's check() takes an `isTest` argument and DROPS every subscription
 * whose `test` flag disagrees with it (`isTest || !subscription.test`). We
 * pass isTest=false for any shop that isn't a Partner dev store, so a
 * subscription Shopify recorded as a test charge became invisible — the
 * settings loader read "no active subscription", concluded FREE, and wrote
 * that over the PREMIUM the app_subscriptions/update webhook had just set. The
 * App Store reviewer hit exactly that on 2026-09-07: six approved Premium
 * charges, each wiped back to Free within seconds of returning to the app.
 *
 * `test` says whether money moves, which is a question for CREATING a charge
 * (see isTestBillingFor) and never for reading entitlement. So this ignores it
 * and reports what is active, however it was billed.
 *
 * Highest tier wins when several subscriptions are active at once — during a
 * plan replacement Shopify can briefly report both.
 *
 * Throws if the query fails, so a caller can leave the cached plan alone
 * rather than downgrade a paying merchant on a transient error.
 */
export async function resolveActivePlan(admin: AdminLike): Promise<{
  plan: PlanId;
  subscriptions: ActiveSubscription[];
}> {
  const json = await (await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY)).json();
  if (json.errors?.length || !json.data?.currentAppInstallation) {
    throw new Error(
      json.errors?.[0]?.message ??
        "no currentAppInstallation in the response",
    );
  }

  const subscriptions: ActiveSubscription[] =
    json.data.currentAppInstallation.activeSubscriptions ?? [];

  let plan: PlanId = "FREE";
  for (const subscription of subscriptions) {
    // Defensive: activeSubscriptions should only ever hold ACTIVE ones, but a
    // PENDING subscription is one the merchant has not approved, and granting
    // on it would hand out the plan for free.
    if (subscription.status !== "ACTIVE") continue;
    const tier = tierForPlanName(subscription.name);
    if (planRank(tier) > planRank(plan)) plan = tier;
  }

  return { plan, subscriptions };
}

if (
  process.env.SHOPIFY_BILLING_TEST === "true" &&
  process.env.NODE_ENV === "production"
) {
  console.warn(
    "[Billing] *** TEST BILLING IS ON IN A PRODUCTION BUILD *** " +
      "Every subscription is a test charge and NO MONEY WILL BE COLLECTED. " +
      "Remove the SHOPIFY_BILLING_TEST app setting once testing is done.",
  );
}

/**
 * The stored settings for a plan transition.
 *
 * Deliberately does NOT touch webhooksEnabled: afterAuth turns it on for every
 * install and it is the lifecycle switch for the change ledger (uninstall
 * turns it off). Plan entitlement is checked separately — see
 * isChangeTrackingEntitled in changelog.server.ts.
 *
 * A retention *shrink* is staged rather than applied. Dropping Premium's 90
 * days to Free's 7 makes almost every backup immediately eligible for
 * permanent deletion by the hourly retention sweep, and that happens on paths
 * the merchant never confirmed: a lapsed trial, a declined card, or a
 * cancellation made from Shopify's own billing UI. The larger window stays in
 * force for RETENTION_GRACE_DAYS so they have time to notice and resubscribe.
 * Growing the window applies at once and clears any staged shrink — there is
 * nothing to protect against when the merchant gains retention.
 */
export function planTransition(
  current: { retentionDays: number } | null,
  plan: PlanId,
) {
  const target = planRetentionDays(plan);
  // Automatic backups are a paid entitlement; drop them on downgrade.
  const base = plan === "FREE" ? { plan, autoBackupEnabled: false } : { plan };

  if (!current || target >= current.retentionDays) {
    return {
      ...base,
      retentionDays: target,
      pendingRetentionDays: null,
      pendingRetentionAt: null,
    };
  }

  return {
    ...base,
    // retentionDays deliberately untouched — the old, larger window stays in
    // force until the grace period elapses.
    pendingRetentionDays: target,
    pendingRetentionAt: new Date(
      Date.now() + RETENTION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
}

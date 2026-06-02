import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Billing plan names. These are the keys merchants are subscribed to and the
// values passed to billing.request / billing.check.
export const STANDARD_PLAN = "Standard";
export const PREMIUM_PLAN = "Premium";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [STANDARD_PLAN]: {
      lineItems: [
        {
          amount: 9,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PREMIUM_PLAN]: {
      lineItems: [
        {
          amount: 19,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Ensure the store exists and enable real-time change tracking so
      // product/collection edits are recorded to the ChangeLog.
      const store = await prisma.store.upsert({
        where: { id: session.shop },
        create: { id: session.shop, webhooksEnabled: true },
        update: { webhooksEnabled: true },
      });

      // On first install, kick off an initial backup so there's an immediate
      // baseline to restore against. Fire-and-forget keeps the OAuth callback fast.
      const backupCount = await prisma.backup.count({
        where: { storeId: session.shop },
      });
      if (backupCount === 0) {
        const { runBackup } = await import("./services/backup.server");
        runBackup(admin, session.shop, "MANUAL", store.plan).catch((err) => {
          console.error(
            `[afterAuth] initial backup failed for ${session.shop}:`,
            err,
          );
        });
      }

      // Register the metafields-scoped products/update webhook (declarative TOML
      // can't set metafieldNamespaces). Idempotent + fire-and-forget.
      const { ensureMetafieldWebhook } = await import(
        "./services/webhook-register.server"
      );
      ensureMetafieldWebhook(admin, process.env.SHOPIFY_APP_URL || "").catch(
        (err) => {
          console.error(`[afterAuth] metafield webhook registration failed:`, err);
        },
      );
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

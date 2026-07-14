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

// Reinstall cleanups (blob wipe + re-baseline backup) still running in this
// process, keyed by shop. afterAuth can fire more than once around a single
// (re)install (parallel requests each doing token exchange), and a later run
// must not re-enable change tracking while an earlier run is still wiping
// stale blobs. In-memory is fine: the app runs as a single instance, and if
// the process restarts mid-cleanup the next afterAuth re-enables tracking
// (recovery path in the else branch below).
const reinstallCleanupInFlight = new Set<string>();

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
      // Ensure the store exists. lastAuthAt lets the app/uninstalled handler
      // drop late-delivered uninstall webhooks that fired before this
      // (re)install completed. Change tracking (webhooksEnabled) is
      // deliberately NOT switched on here: on a reinstall it must stay off
      // until the stale state/ + changes/ blobs are wiped and the re-baseline
      // backup has run — enabling it first would record webhook events diffed
      // against months-stale baselines, into blobs the in-flight wipe then
      // deletes (ledger rows pointing at nothing). The branches below turn it
      // on at the right moment.
      const authAt = new Date();
      const store = await prisma.store.upsert({
        where: { id: session.shop },
        create: { id: session.shop, webhooksEnabled: true, lastAuthAt: authAt },
        update: { lastAuthAt: authAt },
      });

      if (store.uninstalledAt) {
        // Reinstall after an uninstall. The surviving backups and ledger
        // predate the gap — edits made while uninstalled were never tracked —
        // so drop the ledger and re-baseline instead of presenting
        // months-stale data as current (and one-tap revertable).
        //
        // The blob wipe below removes EVERY {shop}/changes/ blob, so the
        // whole ledger goes with it — not just rows older than uninstalledAt
        // (a row stamped moments after it, from an event racing the uninstall
        // handler, would otherwise survive pointing at deleted blobs).
        await prisma.changeLog.deleteMany({ where: { storeId: session.shop } });
        // Clearing uninstalledAt doubles as an atomic claim: if two afterAuth
        // calls race, exactly one runs the cleanup. webhooksEnabled goes (or
        // stays) false in the same statement so the webhook queue keeps
        // dropping events until the cleanup below re-enables it.
        const claimed = await prisma.store.updateMany({
          where: { id: session.shop, uninstalledAt: { not: null } },
          data: { uninstalledAt: null, webhooksEnabled: false },
        });
        if (claimed.count === 0) {
          // A concurrent afterAuth claimed the cleanup; it re-enables
          // tracking when it finishes.
          console.log(
            `[afterAuth] reinstall cleanup already claimed for ${session.shop}`,
          );
        } else {
          reinstallCleanupInFlight.add(session.shop);
          // Blob cleanup + fresh baseline in the background (keeps the OAuth
          // callback fast). The stale state/ baselines must be gone before
          // the new backup re-seeds them — seeding is write-if-absent.
          (async () => {
            const { storage } = await import("./services/storage.server");
            await storage.deletePrefix(`${session.shop}/changes/`);
            await storage.deletePrefix(`${session.shop}/state/`);
            // Run the re-baseline to completion BEFORE re-enabling tracking
            // (unlike the fire-and-forget first-install backup): recordChange
            // diffs a product's first tracked edit against the latest
            // COMPLETED backup, so tracking must not resume while the
            // pre-uninstall backup is still the newest one. Events dropped
            // while tracking is off are folded into the new baseline, same as
            // edits made during the uninstall gap.
            const active = await prisma.backup.findFirst({
              where: {
                storeId: session.shop,
                status: { in: ["PENDING", "IN_PROGRESS"] },
              },
              select: { id: true },
            });
            if (active) {
              console.log(
                `[afterAuth] re-baseline backup not started for ${session.shop}: already-running`,
              );
            } else {
              const { runBackup } = await import("./services/backup.server");
              try {
                await runBackup(admin, session.shop, "MANUAL", store.plan);
              } catch (err) {
                // Still re-enable tracking below: the next re-auth would turn
                // it on regardless, so staying dark only loses changes.
                // runBackup has already marked its Backup row FAILED.
                console.error(
                  `[afterAuth] re-baseline backup failed for ${session.shop}; tracking resumes against the pre-uninstall baseline:`,
                  err,
                );
              }
            }
            // Only now is it safe to record webhook events again. Guarded on
            // uninstalledAt so a store uninstalled AGAIN mid-cleanup doesn't
            // come back with tracking on.
            await prisma.store.updateMany({
              where: { id: session.shop, uninstalledAt: null },
              data: { webhooksEnabled: true },
            });
          })()
            .catch((err) => {
              console.error(
                `[afterAuth] reinstall cleanup failed for ${session.shop} — change tracking stays off until the next re-auth:`,
                err,
              );
            })
            .finally(() => {
              reinstallCleanupInFlight.delete(session.shop);
            });
        }
      } else {
        // Enable real-time change tracking so product/collection edits are
        // recorded to the ChangeLog — unless a reinstall cleanup started by
        // an earlier afterAuth is still running in this process (it
        // re-enables tracking itself once the wipe + re-baseline are done).
        // Enabling here is also the recovery path when such a cleanup died
        // (crash/restart mid-wipe left webhooksEnabled=false with
        // uninstalledAt already cleared): degraded — no fresh wipe or
        // baseline — but tracking must not stay off forever.
        if (
          !store.webhooksEnabled &&
          !reinstallCleanupInFlight.has(session.shop)
        ) {
          console.warn(
            `[afterAuth] re-enabling change tracking for ${session.shop} (was off outside a reinstall cleanup)`,
          );
          await prisma.store.update({
            where: { id: session.shop },
            data: { webhooksEnabled: true },
          });
        }

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
      }

      // Register webhooks declarative TOML can't express (metafields) or that
      // we don't want to depend on `shopify app deploy` to activate
      // (inventory_items/update → cost/HS/origin). Idempotent + fire-and-forget.
      const { ensureWebhooks } = await import(
        "./services/webhook-register.server"
      );
      ensureWebhooks(admin, process.env.SHOPIFY_APP_URL || "").catch((err) => {
        console.error(`[afterAuth] webhook registration failed:`, err);
      });
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

# Production launch runbook

Getting **Backup Restore Undo** from a working dev deployment to a live, paid,
publicly listed Shopify App Store app.

Companion to `azure-deploy.md` (which documents the dev deploy and the Azure
gotchas we already hit and solved). Read the "Gotchas that already bit us"
section at the bottom before starting Phase 1 — every one of them cost us a
debugging session on dev and will cost it again on prod.

**Ordering constraint:** Azure first, Shopify app second, listing third. The
prod Shopify app's `application_url` and redirect URLs must point at a real
hostname, so the Azure web app has to exist before the Shopify app is
configured.

---

## Phase 0 — Pre-flight

### 0.1 Rotate the leaked secrets

These were pasted into a chat transcript during the dev build and must not
carry over to prod:

- [ ] Azure storage account key (dev `devsimplerfid`) — rotate key1
- [ ] Postgres password (dev `dev-simplerfid-postgres`)
- [ ] Shopify API secret (dev app `d8251e1bc82233a5943f5426ee2510d4`)

After rotating, update the dev App Service settings with the new values
(storage connection string has to be re-copied — rotating the key invalidates
the old connection string).

Prod gets brand-new credentials that never touch a transcript.

### 0.2 Confirm the code is release-ready

- [ ] `npm run build` — green
- [ ] `npm run lint` — green
- [ ] Working tree committed and pushed

---

## Phase 1 — Azure prod stack

Create these in the Azure Portal, region **East US** (same as dev, keeps
latency between web app / DB / storage low). Suggested names drop the `dev-`
prefix.

### 1.1 Postgres Flexible Server

- [ ] Name: `simplerfid-postgres` (or reuse the dev server with a separate
      database — a separate server is cleaner and worth the cost)
- [ ] Database name: `shopify-backup`
- [ ] Admin user + a **new** strong password (do not reuse dev's)
- [ ] Networking → **Allow public access from any Azure service within Azure to
      this server** = ON (the web app connects through this)
- [ ] Record the connection string for `DATABASE_URL`:
      `postgresql://USER:PASSWORD@HOST.postgres.database.azure.com:5432/shopify-backup?sslmode=require`

### 1.2 Storage account

- [ ] Name: `simplerfidprod` (storage names are global, lowercase, no hyphens)
- [ ] Blob container: `shopify-backups`, access level **Private**
- [ ] Copy the connection string for `AZURE_STORAGE_CONNECTION_STRING`

### 1.3 Web app

- [ ] Name: `shopify-backup` → `https://shopify-backup.azurewebsites.net`
      (this hostname goes into the Shopify app config in Phase 2 — pick it now
      and don't change it later, changing it means re-deploying Shopify config
      and re-approving OAuth)
- [ ] Runtime: **Node 22 LTS**, Linux
- [ ] Plan: **Basic B1 or higher** (Always On is not available on Free/Shared)
- [ ] Configuration → General settings:
  - [ ] **Always On = On** — required. The backup scheduler and webhook queue
        processor run *in-process* on a timer (`scheduler-init.server.ts`).
        Without Always On, Azure idles the app out and scheduled backups
        silently stop running.
  - [ ] **Startup Command = `npm start`** — required, see gotchas.
  - [ ] **SCM Basic Auth = On** — the publish-profile deploy needs it.
- [ ] Scale out: **stay at 1 instance, no autoscale.** The scheduler and
      webhook processor claim work non-atomically, so exactly one instance may
      run them (`scheduler-init.server.ts:17`). Azure App Service shares app
      settings across all instances, so there's no way to set
      `ENABLE_BACKGROUND_JOBS=false` on *only* the extra instances — scaling
      out means duplicate scheduled backups and double-processed webhooks.
      Scale **up** (bigger instance) if you need more capacity, not out.

### 1.4 App Service environment variables

Configuration → Application settings. All ten:

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | prod Postgres connection string from 1.1 |
| `SHOPIFY_API_KEY` | prod app client ID — **filled in Phase 2** |
| `SHOPIFY_API_SECRET` | prod app secret — **filled in Phase 2** |
| `SCOPES` | the 11-scope string below, exactly |
| `SHOPIFY_APP_URL` | `https://shopify-backup.azurewebsites.net` |
| `STORAGE_PROVIDER` | `azure` |
| `AZURE_STORAGE_CONNECTION_STRING` | from 1.2 |
| `AZURE_STORAGE_CONTAINER` | `shopify-backups` |
| `NODE_ENV` | `production` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` |

Scopes string — must match `shopify.app.prod.toml` character for character, or
merchants get a scope-mismatch reauth loop:

```
read_products,write_products,read_content,write_content,read_online_store_navigation,write_online_store_navigation,read_online_store_pages,read_publications,write_publications,read_inventory,write_inventory
```

> **`NODE_ENV=production` is what turns on real billing.**
> `app/routes/app.settings.tsx:22` sets `IS_TEST_BILLING = process.env.NODE_ENV !== "production"`.
> Get this wrong and every subscription on prod is a test charge that never
> bills a cent — and it fails App Store review.

### 1.5 GitHub secrets

Web app → Deployment Center → **Download publish profile**, then in the GitHub
repo (`vlyakh/shopify-backup-tool`) → Settings → Secrets and variables →
Actions:

- [ ] `AZURE_WEBAPP_NAME_PROD` = `shopify-backup`
- [ ] `AZURE_WEBAPP_PUBLISH_PROFILE_PROD` = full contents of the downloaded
      `.PublishSettings` file

`.github/workflows/deploy-prod.yml` already reads exactly these two names.

---

## Phase 2 — Prod Shopify app

Must be run from a **real interactive terminal** (the CLI opens a browser for
auth), not through me.

- [ ] Log in as the org account: **shopifybackupapp@gmail.com** (org "App
      Forge"). `dev.one@simplerfid.com` gets a 403 on this org.
- [ ] Create + link the prod app:
      ```
      npm run config:link
      ```
      Choose **Create a new app**, name it (toml `name` is capped at 29 chars —
      `Backup Restore Undo` fits; the public listing name is a separate,
      longer field). This writes `shopify.app.<handle>.toml`.
- [ ] Edit the new toml to match prod:
  - `application_url = "https://shopify-backup.azurewebsites.net"`
  - `embedded = true`
  - `[access_scopes] scopes` = the 11-scope string above
  - `[auth] redirect_urls` = the three callback URLs on the prod host:
    `/auth/callback`, `/auth/shopify/callback`, `/api/auth/callback`
  - Copy the entire `[webhooks]` block from `shopify.app.toml` unchanged —
    including all three `compliance_topics` subscriptions, which are
    **mandatory for public apps**
- [ ] Copy the prod app's **client ID and secret** from the Partner Dashboard
      into the Azure settings left blank in 1.4, then restart the web app
- [ ] Deploy the config:
      ```
      shopify app deploy --config <handle> --allow-updates
      ```
      (`--allow-updates`, not `--force` — CLI 4.5.0 renamed it)

---

## Phase 3 — Deploy and smoke-test

- [ ] GitHub → Actions → **Deploy to Azure App Service (PROD)** → Run workflow
      (manual `workflow_dispatch` by design; push-to-main only deploys dev)
- [ ] Watch the run to green, then check the App Service **Log stream** for a
      clean boot: Prisma migrations applied, `[SchedulerInit] Initializing
      backup scheduler...` about 5s after start
- [ ] `https://shopify-backup.azurewebsites.net` returns 200
- [ ] Install on a **fresh development store** and verify:
  - [ ] OAuth completes, app loads embedded in admin
  - [ ] Initial baseline backup runs automatically on install
  - [ ] Edit a product → change appears in the change ledger
  - [ ] Per-field undo reverts correctly
  - [ ] The three theme/admin extensions load
- [ ] Uninstall → reinstall and confirm the re-baseline path runs (blob wipe +
      fresh backup, tracking re-enabled afterwards)

---

## Phase 4 — Billing verification

Billing is already implemented — `app/shopify.server.ts` declares the plans,
`app/routes/app.settings.tsx` drives them. What's left is verifying it against
the live prod app.

Current plan config:

| Plan | Price | Trial | Retention | Key entitlements |
| --- | --- | --- | --- | --- |
| Free | $0 | — | 7 days | Manual backups, products only |
| Standard | $9/mo | 14 days | 30 days | Daily auto-backups, all resource types, one-click restore |
| Premium | $19/mo | 14 days | 90 days | Real-time change tracking, change history, field-level undo |

- [ ] On the test store, subscribe to Standard → Shopify's confirmation page
      shows **$9/month with a 14-day free trial**
- [ ] Approve → returns to `/app/settings`, plan card shows Standard as current
      (the loader reconciles from `billing.check`, so this confirms the whole
      round trip)
- [ ] Upgrade Standard → Premium works without reinstalling
- [ ] Downgrade to Free cancels the subscription (prorated)
- [ ] Charges appear in the store's app charge history

Two things to know about the trial:

1. **Trials are granted per subscription, not per shop.** A merchant who
   cancels and resubscribes gets another 14 days, and a Standard → Premium
   upgrade starts a fresh 14-day trial on the new subscription. Low risk at
   this price point; noted so it isn't a surprise in the revenue numbers.
2. **A lapsed trial drops retention from 30/90 days to 7.** `planSettings("FREE")`
   sets `retentionDays: 7`, so backups older than a week become eligible for
   pruning once a merchant falls back to Free. Existing behaviour, but trials
   will push more merchants through that path — consider whether the settings
   page should warn before a downgrade takes effect.

Review requires that merchants can change plans without contacting support or
reinstalling — the settings page satisfies this, and the checks above prove it.

---

## Phase 5 — App Store listing and submission

### 5.1 Assets to produce

Image standards are enforced as of March 26, 2026.

- [ ] **App icon** — 1200×1200px, JPEG or PNG. Bold colours, simple
      recognizable mark. No text, no screenshots, no Shopify trademarks. Square
      corners (rounded automatically), with padding so the mark doesn't touch
      the edges.
- [ ] **Feature media** — 1600×900 (16:9). One focal point, solid background,
      4.5:1 contrast, alt text.
- [ ] **Screenshots** — 3–6 desktop images at 1600×900, at least one showing
      the app's actual UI. Crop out browser chrome. No PII, no pricing, no
      review quotes, no outcome guarantees.
- [ ] **Video (optional, recommended)** — 2–3 minutes, promotional rather than
      instructional, screencast limited to ~25% of the runtime.

Natural screenshot candidates: the dashboard with a backup list, the change
timeline with a field-level diff, a one-tap undo, and the settings/plans page.

### 5.2 Listing fields

- [ ] App name (public listing name — can be longer than the 29-char toml name,
      e.g. "Backup, Restore & Undo Changes")
- [ ] Tagline / app card subtitle
- [ ] Full description — what it backs up, how undo works, retention per plan
- [ ] **Pricing details — must exactly match the code**: Free $0, Standard
      $9/mo, Premium $19/mo, 14-day trial on both paid plans. A mismatch
      between listing and actual charges is a standard review rejection.
- [ ] **Privacy policy URL** — mandatory. Needs to be publicly reachable and
      cover what the app stores (product/collection snapshots in blob storage,
      shop domain, change history) and for how long (retention per plan).
- [ ] Support contact email + emergency developer contact (must stay current)
- [ ] Demo store URL

### 5.3 Reviewer handoff

- [ ] Development store, pre-populated with products/collections, with the app
      installed and a few backups plus tracked changes already present — the
      reviewer must be able to see undo work without doing setup
- [ ] Written test instructions: install → edit a product → open the change
      timeline → undo a single field
- [ ] Screencast of that flow

### 5.4 Requirements already satisfied

Verified against the code, no action needed — listed so you can answer review
questions:

- **OAuth first** — `authenticate.admin` on every route, OAuth before any other
  step, including on reinstall
- **Session tokens, not cookies** — `unstable_newEmbeddedAuthStrategy: true`
- **App Bridge / embedded** — `embedded = true`, App Bridge React throughout
- **Billing API** — plans declared in `shopify.server.ts`, upgrade/downgrade
  self-service in settings
- **GDPR webhooks** — all three (`customers/data_request`, `customers/redact`,
  `shop/redact`) declared and implemented
- **Current API version** — `2026-04` / `ApiVersion.April26`; extensions on
  `2025-07`. Apps on APIs deprecated within 90 days can't be submitted, so
  re-check this if submission slips by a couple of quarters.

The one requirement worth actively testing: the app must work in **Chrome
incognito**. Worth a five-minute check on the test store before submitting.

---

## Gotchas that already bit us

From the dev deploy — all still apply to prod:

- **Azure Startup Command must be `npm start`.** The `azure/webapps-deploy`
  action can't set a startup command under publish-profile auth, so the app is
  self-starting: `npm start` runs `prisma migrate deploy` then `remix-serve`.
  Chained with `&&`, so the server only boots if migrations succeeded.
- **`npm start` invokes real paths, not `.bin` shims.** The zip step follows
  symlinks and flattens them, which breaks `__dirname` for the Prisma CLI
  (`ENOENT prisma_schema_build_bg.wasm`). Hence
  `node node_modules/prisma/build/index.js` rather than `npx prisma`.
- **`npm install`, not `npm ci`.** The Windows-generated lockfile omits
  Linux-only nested optional deps (`@emnapi/*`), which the stricter `npm ci`
  rejects on the Linux runner.
- **Prisma client is regenerated after `npm prune`** — pruning can delete
  `node_modules/.prisma`.
- **`startup.sh` loses its +x bit through zip → unzip.** Don't rely on it;
  that's why the startup command is `npm start`.
- **Postgres firewall**: "Allow Azure services" must be ON or the web app
  can't reach the database.

---

## Order of operations, condensed

```
0. Rotate dev secrets, verify build
1. Azure: Postgres → storage → web app (Always On, npm start, 1 instance)
   → env vars → publish profile into GitHub secrets
2. Shopify: config link → new prod app → edit toml → copy key/secret into
   Azure → shopify app deploy --config <handle> --allow-updates
3. Run the PROD workflow → smoke-test install, backup, undo on a test store
4. Verify billing end to end with real (non-test) charges
5. Produce listing assets → fill listing → prep reviewer store → submit
```

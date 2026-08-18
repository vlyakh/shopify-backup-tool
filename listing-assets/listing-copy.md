# App Store listing copy — Backup Restore Undo

Drafted against three competing positioning angles, scored by an adversarial
judge, then corrected for every overclaim it found. The winning angle is
**precision over rewind**: field-level revert, which is the one thing the
incumbents structurally do not do.

Shopify's listing form has hard character limits and they are SHORTER than
this body copy. Trimmed versions for each field are given first; the long
form below is the source to cut from.

---

## Privacy policy URL (required by App Store review)

https://backup-restore-undo.azurewebsites.net/privacy

Served by the app itself as a public, unauthenticated route — no external
hosting needed, and it cannot drift out of sync with a separately hosted copy.

---

## Listing fields (paste these)

**App name** (30 char limit)
Backup Restore Undo

**Tagline / subtitle** (62 char limit)
Undo one product field. Don't rewind your whole store.

**App introduction** (100 char limit)
Revert a single product field from the product page, without touching anything else.

**App details** (500 char limit)
The price is off by a decimal. The title has someone else's wording. You did not do it.
You already know which field is wrong, so fix that one field — the fields you do not
select are never written. Underneath, manual and scheduled backups of products,
collections, pages, blogs, redirects and menus. Premium adds change tracking: which
field changed, what it was before, and when — including edits made by bulk imports,
teammates and other apps.

**Feature list** (max 5)
- Undo one field from the product page without touching the other twenty.
- See which field changed, what it was before, and exactly when.
- Catches edits from bulk edits, CSV imports, teammates and other apps.
- Manual and scheduled backups: products, collections, pages, blogs, menus.
- Recover deleted products, or restore only the ones a bad import changed.

**Search terms** (max 5)
backup and restore, undo product edits, product change history, revert price change, recover deleted products

---

## Screenshot captions

1. Changed fields, with their previous values, right on the product page.
2. What the value was, and what it is now, for a single edit.
3. Undo the wrong price — the description you rewrote on Wednesday stays.
4. Manual and scheduled backups of products, collections, pages, blogs and menus.
5. Bring back deleted products, or restore changed products in bulk.

---

## Long form (source copy — trim to fit the fields above)

The price is off by a decimal. The title has someone else's wording in it. Three variants lost their weights. You did not do it.

You already know which field is wrong, so fix that one field. Backup Restore Undo reverts the single field you point at — the fields you do not select are never written — from the product page where you noticed the problem. Underneath it runs manual and scheduled backups of products, collections, pages, blogs, redirects and menus.

SEE WHAT CHANGED (PREMIUM)

Change tracking records product edits as they happen and keeps the value that was there before. Open a product and you get a plain list: which field changed, what it was, what it is now, and when.

Tracked fields include title, price, status, product category, variants, cost, HS code, country of origin, weight, online store publish and unpublish, and metafields in the custom and global namespaces.

It records your store's own change events rather than only the app's own actions, so a tracked field looks the same in the history whether the edit came from the admin, a bulk edit, a CSV import, a teammate, or another app writing to your catalog on its own schedule.

The history shows what changed and when. It does not report who made the change.

CHOOSE HOW MUCH TO MOVE

- Revert one field, and only that field.
- Revert every change on that product since its last backup, in one action.
- Restore a set of products that changed, as a bulk action from the product list — wider than one field, far narrower than a whole-store restore.

You are not rewinding the clock. You are correcting one value.

NOTICING LATE COSTS FAR LESS

A point-in-time restore puts the whole product back the way it looked at the moment of the backup, which is exactly what you want after a deletion or a wholesale mess — and it is on every paid plan.

But it also discards the intentional work done since. Rewrite a description on Wednesday, spot a bad price on Friday, and a full restore makes you choose between them.

Per-field undo does not. It rewrites one attribute and leaves the other twenty alone, so reverting Friday's price does not touch Wednesday's description.

One honest limit: if a variant has been deleted and recreated since the change, that variant's earlier values can only be put back by restoring the product from a backup.

REAL BACKUPS UNDERNEATH

Precision only helps if there is something to go back to. Manual backups on demand, plus automatic backups daily or weekly, into private storage:

- Products, including variants, images and metafields
- Collections
- Pages
- Blogs and articles
- URL redirects
- Navigation menus

One-click restore brings a single product back from a backup. Recover Deleted Products brings back products that are gone from the store entirely, using what was captured before they disappeared.

IT LIVES WHERE YOU WORK

The app adds blocks and actions inside your store's admin, not just in its own dashboard:

- Backup Status on the product page, so you can see what is protected
- Undo Product Changes on the product page, with the change history and the revert action together
- Recover Deleted Products, from the product list
- Restore Changed Products, as a bulk action on the product list

WHAT IT DOES NOT COVER

Worth knowing now rather than on the day you need it. The app covers your catalog and storefront content: products, collections, pages, blogs and articles, URL redirects and navigation menus. It does not back up orders, customers, themes, files or inventory quantities. If those are what you need protected, this is not your app. What it does cover, it covers down to the field.

GETTING STARTED

Install the app and run your first backup — it takes a couple of clicks. Set a daily or weekly schedule so you stop thinking about it. On Premium, turn on change tracking and pin the Undo block to your product pages, so the last few days of edits are always one scroll away.

---

## Accuracy corrections the judge caught

These were in earlier drafts and are removed. Do not reintroduce them — each is a
functional-mismatch complaint waiting to happen:

- **No "who" attribution.** Product webhooks carry no actor. The app shows what
  changed and when, never who. Avoid "audit log" as a search term for the same reason.
- **Metafields are not fully covered.** Only the custom and global namespaces; variant
  metafields are not tracked at all.
- **Publishing means Online Store only.** Per-channel publishing for other sales
  channels is not tracked.
- **The Undo block is not automatic.** It is an admin UI extension the merchant adds to
  the product page. Do not imply it appears on install.
- **"Noticing late stops being a problem" is false.** Once variants are added the
  original variant id dies and per-variant undo of an earlier edit falls back to
  revert-all-to-backup. The copy says "costs far less", deliberately.
- **The exclusion list must include inventory quantities**, alongside orders, customers,
  themes and files. An incomplete exclusion list is itself a claim.
- **No reliability or availability promises**, even implied ones.
- **No disparagement of Shopify's native features** and no scare claims about platform
  behaviour.


---

## LISTING FIELDS AS ACTUALLY SUBMITTED

The drafts above were written before Shopify's listing form revealed its real
constraints. These are the versions that pass its validation — use these.

**App card subtitle**
Back up your store and undo a single product field, not everything.

**App introduction** (100 chars, must read as two sentences)
Backs up your products and content. Undo the one field that changed, not the whole store.

**App details** (429 chars — the form REJECTS the word "plan" and any pricing
reference outside the pricing section)
Backup Restore Undo keeps manual and scheduled backups of your products, collections, pages, blogs, redirects and navigation menus. If a product is changed by mistake, you can revert the single field that is wrong from the product page, instead of restoring the whole product. It can also record each edit as it happens, so you can see which field changed and what it was before, including changes made by imports and other apps.

**Features** (3-5, no mechanics, no marketing language)
- Undo a single product field without changing anything else.
- See which field changed, what it was before, and when it happened.
- Catch edits made by imports, other apps, and staff.
- Back up products, collections, pages, blogs, redirects and menus.
- Recover deleted products, or restore only the ones that changed.

**Search terms** (max 5, each <=20 chars, one idea each, no "Shopify")
store backup / product backup / undo product edits / restore products / recover deleted

**SEO title** (<=60)
Backup Restore Undo: store backups with per-field undo

**SEO meta description**
Back up your products, collections, pages and blogs. When an edit goes wrong, undo the single field that changed instead of restoring your whole store.

**Category**: Store management > Security > Security - Other (Rewind uses the same)

**Install requirements**: Shopify Online Store REQUIRED, POS not required. A single
failing resource query aborts the whole backup, so a store without the Online
Store channel could get failing backups.

**Test account**: "My app doesn't require an account to use it" — fully embedded,
Shopify OAuth only. Supplying Shopify test-store credentials is explicitly forbidden.

**Pricing**: stay on MANUAL pricing. Do not migrate to App Pricing — it would
discard the hardened Billing API path (trial-once-per-shop, retention grace,
admin deep-link returnUrl, app_subscriptions/update reconciliation). List three
public plans only; the two "(14-day trial)" plan names in the billing config are
implementation detail.

**Alt text** (<=64 chars each)
- feature media: Undo panel reverting one product field, not the whole store
- 1 undo: Undo panel showing a price change with an undo button
- 2 dashboard: Dashboard listing completed backups and a run backup button
- 3 recover deleted: Recover deleted products panel with a restore button
- 4 change history: Change history table of product edits and what changed
- 5 restore changed: Panel listing changed products, each with a revert button

**Screencast** (required, 3-8 min, YouTube Unlisted): install -> Run Backup ->
edit a product price -> Undo that one field (the core) -> Change History ->
Restore Changed / Recover Deleted -> Settings showing self-service plan switching
(review specifically verifies merchants can change plans without contacting support).

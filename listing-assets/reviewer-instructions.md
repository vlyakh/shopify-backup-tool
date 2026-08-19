# Reviewer instructions

Paste into the "Instructions for reviewers" field at submission. Fill in the
bracketed values first.

Review is judged on whether a reviewer can see the app work **without doing
setup themselves**. The single biggest risk for this app is that they install
it, open a product, and the change history is empty — because the ledger only
starts recording after a completed backup, and only on the Premium plan. Both
must already be true on the demo store before you submit.

---

## Demo store

- Store URL: [https://your-demo-store.myshopify.com]
- Storefront password: [password]
- The app is already installed, on the **Premium** plan, with backups and
  tracked changes already present.

## What the app does

Reverta backs up store content (products, collections, pages,
blogs, redirects, menus) and lets a merchant restore it. Its distinguishing
feature is reverting a **single product field** from the product page, rather
than restoring a whole backup.

The app does not read or store orders, customers, customer personal data,
themes, files or inventory quantities.

## Test steps

**1. See the existing backups**
Apps → Reverta. The dashboard lists completed backups. Click one to
see the items it captured.

**2. Run a backup**
Click "Run Backup" and wait for the status to reach Completed (a few seconds on
this store).

**3. Make a change to a product**
Products → pick any product → change the price or the title → Save.

**4. See the change recorded**
Reopen that product. The "Undo Product Changes" block on the product page lists
the field that changed, its previous value, and when it changed.

**5. Undo one field**
Click the revert action next to that single field. The field returns to its
previous value; other fields on the product are untouched. This is the core of
the app.

**6. Undo everything on a product**
The same block offers reverting all changes on that product since its last
backup, in one action.

**7. Bulk actions from the product list**
Products list → the "..." / bulk actions menu offers:
- **Recover Deleted Products** — restores products deleted from the store
- **Restore Changed Products** — restores products that changed since the backup

**8. Billing**
Apps → Reverta → Settings shows the three plans and allows
switching between them without contacting support or reinstalling. Free,
Standard ($9/month) and Premium ($19/month) are all self-service, and
downgrading warns before it takes effect.

## Notes

- **Change tracking and per-field undo are Premium features.** The demo store
  is on Premium so they are visible. On Free and Standard the change history is
  intentionally not recorded.
- **The change history requires a completed backup**, which is the baseline it
  compares against. The demo store already has one.
- The Undo and Backup Status blocks are admin UI extensions on the product
  page. They are already enabled on the demo store.
- Privacy policy: https://reverta.azurewebsites.net/privacy

## Contact

[support email] — [emergency developer contact]

---

## Pre-submission checklist for the demo store

Do all of these before submitting, or a reviewer will land on an empty app:

- [ ] Store has 15+ realistic products with real names and images (not
      "Test Product 1" — this also makes better screenshots)
- [ ] At least one blog with an article, and at least one URL redirect, so
      those resource types actually appear in a backup
- [ ] App installed and subscribed to **Premium**
- [ ] At least two **completed** backups exist
- [ ] Several products edited **after** the last backup, so the change history
      has content
- [ ] At least one product deleted after a backup, so Recover Deleted Products
      has something to show
- [ ] Undo and Backup Status blocks pinned to the product page layout
- [ ] Verify the whole flow yourself in **Chrome incognito** — App Store review
      tests in a clean session, and third-party cookie behaviour differs there

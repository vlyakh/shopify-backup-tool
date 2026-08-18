import type { MetaFunction } from "@remix-run/node";

// Public, unauthenticated route: the App Store listing requires a privacy
// policy URL that anyone can reach without installing the app. Deliberately
// NOT under /app (those routes all call authenticate.admin) and deliberately
// not using Polaris/App Bridge, which assume an embedded admin context.
//
// Everything below must stay true to what the code actually does. A privacy
// policy that overstates deletion or understates collection is worse than
// none: it is a compliance claim, and app review reads it against the
// mandatory webhooks.

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — Backup Restore Undo" },
  { name: "robots", content: "index" },
];

const UPDATED = "18 August 2026";
const CONTACT = "shopifybackupapp@gmail.com";

export default function Privacy() {
  return (
    <main
      style={{
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "3rem 1.25rem 6rem",
        font: '16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: "#1f2330",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: ".25rem" }}>Privacy Policy</h1>
      <p style={{ color: "#5c6070", marginTop: 0 }}>
        Backup Restore Undo · Last updated {UPDATED}
      </p>

      <p>
        Backup Restore Undo (&ldquo;the app&rdquo;) backs up store content and
        lets merchants restore or undo changes to it. This policy describes
        what the app stores, why, where it is held, and how long it is kept.
      </p>

      <h2>What the app stores</h2>

      <h3>Store content</h3>
      <p>
        When a backup runs, the app copies the following from the store and
        keeps it as snapshots: products (including variants, product images and
        metafields in the custom and global namespaces), collections, pages,
        blogs and articles, URL redirects, and navigation menus.
      </p>
      <p>
        On the Premium plan the app also records product changes as they
        happen, storing the value of a field before and after each change so it
        can be reverted.
      </p>

      <h3>What the app does not store</h3>
      <p>
        The app does <strong>not</strong> read or store orders, customers,
        customer personal data, themes, files, or inventory quantities. No
        customer personal information is collected, processed or retained by
        this app at any point.
      </p>

      <h3>Feedback you send us</h3>
      <p>
        If you use the in-app feedback form, the app stores the message you
        write, the type of feedback you selected, your store&rsquo;s domain, and
        the email address you optionally provide for a reply. This is used only
        to answer you and to improve the app. Please do not include customer
        details in the message. It is deleted along with everything else when
        the app is uninstalled.
      </p>

      <h3>Account and installation data</h3>
      <p>
        To operate, the app stores the store&rsquo;s myshopify.com domain, its
        plan and settings, and the access token that authorises the app to call
        Shopify on the store&rsquo;s behalf. Where Shopify provides them as part
        of authentication, the app also stores the name, email address, locale
        and account-owner status of the staff account that installed or
        authenticated the app. This data is used only to keep the app working
        for that store; it is never sold, and never used for advertising.
      </p>

      <h2>Where it is held</h2>
      <p>
        Snapshots are written to private Microsoft Azure Blob Storage; settings
        and change records are stored in a Microsoft Azure Database for
        PostgreSQL instance. Both are hosted in the United States (Azure Central
        US region). Storage containers are private and are not publicly
        readable.
      </p>

      <h2>How long it is kept</h2>
      <ul>
        <li>Free plan: backups are kept for 7 days.</li>
        <li>Standard plan: backups are kept for 30 days.</li>
        <li>Premium plan: backups are kept for 90 days.</li>
      </ul>
      <p>
        Older backups are deleted automatically once they fall outside the
        plan&rsquo;s window, except that the most recent completed backup is
        always retained so a store is never left with none. If a store moves to
        a shorter retention window, the change takes effect after a 30-day grace
        period rather than immediately, so history is not lost the moment a plan
        lapses.
      </p>

      <h2>Uninstalling and deletion</h2>
      <p>
        When the app is uninstalled, scheduled backups stop and the app&rsquo;s
        access to the store ends immediately. Shopify then sends a shop data
        erasure request, on receipt of which the app permanently deletes all
        stored snapshots, change records, settings and session data for that
        store. If that request never arrives, the app deletes the same data
        automatically 30 days after the uninstall.
      </p>
      <p>
        The app implements all three of Shopify&rsquo;s mandatory compliance
        webhooks. Because the app holds no customer personal data, customer data
        requests and customer redaction requests return no data; shop redaction
        erases everything described above.
      </p>
      <p>
        A merchant can also delete all stored backups at any time from the
        app&rsquo;s settings page, without uninstalling.
      </p>

      <h2>Sharing</h2>
      <p>
        Stored data is not sold, rented or shared with third parties. It is
        processed only by the infrastructure providers needed to run the app:
        Microsoft Azure (hosting, database and storage) and Shopify (the source
        of the data and the platform the app runs on).
      </p>

      <h2>Security</h2>
      <p>
        Traffic to the app is served over HTTPS only. Storage containers are
        private, the database is reachable only over TLS, and the app connects
        to it with a dedicated account limited to its own database.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If this policy changes, the &ldquo;last updated&rdquo; date above will
        change with it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy, or requests relating to stored data, can be
        sent to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </main>
  );
}

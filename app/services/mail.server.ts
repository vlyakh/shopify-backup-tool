import nodemailer from "nodemailer";

/**
 * Outbound notification mail.
 *
 * Only used to tell us a merchant sent feedback. It is deliberately
 * best-effort: the Feedback row is written first and is the record of truth,
 * so an SMTP outage costs a notification and never a merchant's message.
 *
 * Configured with a Gmail app password rather than a transactional provider
 * because the app has no custom domain, and every provider worth using
 * (Resend, Postmark, SendGrid) wants a verified sending domain. Sending from
 * the support mailbox to itself needs nothing but the mailbox.
 *
 * Unset credentials are a supported state, not an error: local and CI runs
 * simply skip the send.
 */
const SMTP_HOST = process.env.SMTP_HOST ?? "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 465);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
const MAIL_TO = process.env.FEEDBACK_TO ?? SMTP_USER;

export function mailConfigured(): boolean {
  return Boolean(SMTP_USER && SMTP_PASS && MAIL_TO);
}

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      // 465 is implicit TLS; anything else (587) upgrades via STARTTLS.
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Send one notification. Returns whether it actually went out — callers record
 * that rather than treating a failure as the merchant's problem.
 */
export async function sendMail(opts: {
  subject: string;
  text: string;
  replyTo?: string | null;
}): Promise<boolean> {
  if (!mailConfigured()) {
    console.warn("[Mail] SMTP not configured; skipping send:", opts.subject);
    return false;
  }
  try {
    await getTransporter().sendMail({
      from: `Reverta <${SMTP_USER}>`,
      to: MAIL_TO,
      subject: opts.subject,
      text: opts.text,
      // Hitting reply goes to the merchant when they asked for one, and to the
      // support mailbox when they didn't.
      replyTo: opts.replyTo || undefined,
    });
    return true;
  } catch (error) {
    console.error(
      `[Mail] Send failed (${opts.subject}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

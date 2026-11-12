/** Outbound messages to people: Slack, Microsoft Teams and email. */
import type { EmailConfig } from "./types";
import type { Secret } from "./credentials";
import { assertProviderUrl } from "./credentials";
import { requestJson, type FetchLike } from "./http";
import type { Logger } from "../platform/logger";

export interface ChatMessage {
  title: string;
  body: string;
  url: string;
}

export class ChatNotifier {
  constructor(private fetchImpl: FetchLike) {}

  async slack(secret: Secret, msg: ChatMessage): Promise<void> {
    const text = `*${msg.title}*\n${msg.body}\n<${msg.url}|Open in ForgePilot>`;
    if (secret.webhookUrl) {
      await requestJson(
        this.fetchImpl,
        "slack",
        assertProviderUrl("slack", secret.webhookUrl).toString(),
        {
          method: "POST",
          body: { text },
        },
      ).catch((err) => {
        // Incoming webhooks answer with the plain text "ok", which is not JSON.
        if (!/non-JSON/.test((err as Error).message)) throw err;
      });
      return;
    }
    const res = await requestJson<{ ok: boolean; error?: string }>(
      this.fetchImpl,
      "slack",
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret.botToken}` },
        body: { channel: secret.channel, text, unfurl_links: false },
      },
    );
    if (!res.ok) throw new Error(`Slack chat.postMessage failed: ${res.error ?? "unknown"}`);
  }

  async teams(secret: Secret, msg: ChatMessage): Promise<void> {
    await requestJson(
      this.fetchImpl,
      "teams",
      assertProviderUrl("teams", secret.webhookUrl).toString(),
      {
        method: "POST",
        body: { text: `**${msg.title}**\n\n${msg.body}\n\n[Open in ForgePilot](${msg.url})` },
      },
    ).catch((err) => {
      if (!/non-JSON/.test((err as Error).message)) throw err;
    });
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type TemplateData = Record<string, string>;

/** Plain, readable transactional emails. Every interpolated value is HTML-escaped. */
export const EMAIL_TEMPLATES: Record<string, (d: TemplateData) => Omit<EmailMessage, "to">> = {
  invitation: (d) => ({
    subject: `${d.inviter} invited you to ${d.workspace} on ForgePilot`,
    text: `${d.inviter} invited you to join ${d.workspace} as ${d.role}.\n\nAccept the invitation: ${d.link}\n\nThe link expires in 14 days.`,
    html: `<p>${escapeHtml(d.inviter)} invited you to join <strong>${escapeHtml(d.workspace)}</strong> as ${escapeHtml(d.role)}.</p><p><a href="${escapeHtml(d.link)}">Accept the invitation</a></p><p>The link expires in 14 days.</p>`,
  }),
  password_reset: (d) => ({
    subject: "Reset your ForgePilot password",
    text: `Hi ${d.name},\n\nReset your password: ${d.link}\n\nThe link works once and expires in an hour. If you didn't ask for this, ignore this email.`,
    html: `<p>Hi ${escapeHtml(d.name)},</p><p><a href="${escapeHtml(d.link)}">Reset your password</a></p><p>The link works once and expires in an hour. If you didn't ask for this, ignore this email.</p>`,
  }),
  verify_email: (d) => ({
    subject: "Confirm your email for ForgePilot",
    text: `Hi ${d.name},\n\nConfirm your email address: ${d.link}\n\nThe link expires in 3 days.`,
    html: `<p>Hi ${escapeHtml(d.name)},</p><p><a href="${escapeHtml(d.link)}">Confirm your email address</a></p><p>The link expires in 3 days.</p>`,
  }),
  notification: (d) => ({
    subject: d.title,
    text: `${d.title}\n\n${d.body}\n\n${d.link}`,
    html: `<p><strong>${escapeHtml(d.title)}</strong></p><p>${escapeHtml(d.body)}</p><p><a href="${escapeHtml(d.link)}">Open in ForgePilot</a></p>`,
  }),
};

export class Mailer {
  /** Messages kept in memory when no provider is configured (development and tests). */
  readonly outbox: EmailMessage[] = [];

  constructor(
    private cfg: EmailConfig,
    private fetchImpl: FetchLike,
    private log: Logger,
  ) {}

  async send(to: string, template: string, data: TemplateData): Promise<void> {
    const render = EMAIL_TEMPLATES[template];
    if (!render) throw new Error(`Unknown email template "${template}"`);
    const message: EmailMessage = { to, ...render(data) };
    if (!this.cfg.resendApiKey) {
      this.outbox.push(message);
      if (this.outbox.length > 100) this.outbox.shift();
      this.log.info({ to, subject: message.subject }, "email not sent: no provider configured");
      return;
    }
    await requestJson(this.fetchImpl, "resend", "https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.resendApiKey}` },
      body: {
        from: this.cfg.from,
        to: [to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      },
    });
  }
}

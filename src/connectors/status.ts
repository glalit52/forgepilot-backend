/**
 * Which platform-level connectors are configured. Used by `pnpm doctor`, the
 * startup log and /readyz so a missing credential is visible immediately
 * instead of surfacing as a failed request later.
 */
import type { Config } from "../config";

export interface ConnectorStatus {
  id: string;
  name: string;
  /** ready = all settings present; partial = some present; off = none (the feature is disabled or simulated). */
  state: "ready" | "partial" | "off";
  /** Environment variables still missing. */
  missing: string[];
  whenOff: string;
}

export function connectorStatus(config: Config): ConnectorStatus[] {
  const check = (
    id: string,
    name: string,
    whenOff: string,
    vars: Record<string, unknown>,
  ): ConnectorStatus => {
    const missing = Object.entries(vars)
      .filter(
        ([, v]) =>
          v === undefined ||
          v === "" ||
          (typeof v === "object" && v !== null && !Object.keys(v).length),
      )
      .map(([k]) => k);
    const total = Object.keys(vars).length;
    return {
      id,
      name,
      state: missing.length === 0 ? "ready" : missing.length === total ? "off" : "partial",
      missing,
      whenOff,
    };
  };
  const { github, stripe, email } = config;
  return [
    check(
      "database",
      "PostgreSQL",
      "Uses the embedded development database (not for production).",
      {
        DATABASE_URL: config.databaseUrl.startsWith("pglite:") ? undefined : config.databaseUrl,
      },
    ),
    check(
      "vault",
      "Credential vault key",
      "A temporary key is generated at boot; stored credentials are lost on restart.",
      {
        VAULT_KEY: config.vaultKey,
      },
    ),
    check("github_app", "GitHub App", "Repositories, pull requests and check runs are simulated.", {
      GITHUB_APP_ID: github.appId,
      GITHUB_APP_SLUG: github.appSlug,
      GITHUB_APP_PRIVATE_KEY: github.privateKey,
      GITHUB_WEBHOOK_SECRET: github.webhookSecret,
    }),
    check("github_oauth", "Sign in with GitHub", "Only email and password sign-in is offered.", {
      GITHUB_OAUTH_CLIENT_ID: github.oauthClientId,
      GITHUB_OAUTH_CLIENT_SECRET: github.oauthClientSecret,
    }),
    check("stripe", "Stripe billing", "Plan changes are refused outside demo mode.", {
      STRIPE_SECRET_KEY: stripe.secretKey,
      STRIPE_WEBHOOK_SECRET: stripe.webhookSecret,
      STRIPE_PRICES: stripe.prices,
    }),
    check("staff", "Back-office staff list", "Nobody can open the staff back-office (/admin).", {
      PLATFORM_ADMIN_EMAILS: config.platformAdmins,
    }),
    check(
      "usage_meters",
      "Stripe usage meters",
      "Metered usage is tracked but not sent to Stripe.",
      {
        STRIPE_METERS: stripe.meters,
      },
    ),
    check("email", "Email (Resend)", "Emails are logged instead of sent.", {
      RESEND_API_KEY: email.resendApiKey,
    }),
  ];
}

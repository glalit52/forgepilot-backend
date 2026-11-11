# Connecting your accounts

The connector code is in place; each one only needs credentials from your own accounts. Nothing here requires a code change: set the environment variables, restart, and check with

```bash
pnpm run connectors
```

which prints every connector as READY, PARTIAL or OFF and names the variables still missing. The same list is logged when the server starts.

There are two kinds of connector:

- **Platform connectors** belong to ForgePilot the company. Your developer sets them once, as environment variables (sections 1–6).
- **Workspace connectors** belong to each customer. Customers connect them in the app under Integrations; the secret is encrypted and stored per workspace (section 7).

Replace `https://api.example.com` below with the public URL of this backend and `https://app.example.com` with the web app.

## 1. Database (PostgreSQL)

Create a managed PostgreSQL 15+ database (Neon, Supabase, AWS RDS, Google Cloud SQL, Railway, Render all work) and set:

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

Tables are created automatically at first start. Turn on daily backups and point-in-time recovery with your provider. Without this variable the server uses a small embedded database in `.data/`, which is only for development.

## 2. Credential vault key

Encrypts every customer credential before it is stored. Generate once and keep it in your secret manager; losing it makes stored credentials unreadable.

```bash
openssl rand -base64 32
```

```
VAULT_KEY=<output>
```

## 3. GitHub App (repositories, pull requests, check runs)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

| Setting                            | Value                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Homepage URL                       | `https://app.example.com`                                                                                   |
| Setup URL (redirect after install) | `https://app.example.com/onboarding`                                                                        |
| Webhook URL                        | `https://api.example.com/api/v1/webhooks/github`                                                            |
| Webhook secret                     | a random string you generate                                                                                |
| Repository permissions             | Contents: Read & write · Pull requests: Read & write · Checks: Read & write · Issues: Read · Metadata: Read |
| Subscribe to events                | Pull request · Pull request review · Push · Issues · Installation                                           |

Then generate a private key (downloads a `.pem`) and set:

```
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_WEBHOOK_SECRET=<the webhook secret>
EXECUTION_MODE=live
```

The private key goes on one line with `\n` for line breaks. `EXECUTION_MODE=live` switches agents, test runs and scans from simulated to real.

## 4. Sign in with GitHub (optional)

In the same GitHub App, under "Identifying and authorizing users", or as a separate OAuth App:

| Setting      | Value                                                 |
| ------------ | ----------------------------------------------------- |
| Callback URL | `https://api.example.com/api/v1/auth/github/callback` |

```
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

## 5. Stripe

Start in **test mode** (sandbox); switching to live later is only a change of keys.

1. Stripe Dashboard → Product catalogue: create one product per paid plan (Developer, Pro, Team, Business), each with a monthly and an annual recurring price. Copy the eight `price_…` ids.
2. Developers → API keys: copy the secret key (`sk_test_…`).
3. Developers → Webhooks → Add endpoint: `https://api.example.com/api/v1/webhooks/stripe`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`. Copy the signing secret (`whsec_…`).
4. Settings → Billing → Customer portal: activate it.

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICES={"developer":{"monthly":"price_...","annual":"price_..."},"pro":{"monthly":"price_...","annual":"price_..."},"team":{"monthly":"price_...","annual":"price_..."},"business":{"monthly":"price_...","annual":"price_..."}}
```

To test webhooks on a laptop: `stripe listen --forward-to localhost:8080/api/v1/webhooks/stripe` and use the secret it prints.

Use a restricted key in production with write access to Customers, Checkout Sessions, Subscriptions and Customer portal only.

## 6. Email (Resend)

Used for invitations and password resets. Create an API key at resend.com and verify your sending domain.

```
RESEND_API_KEY=re_...
EMAIL_FROM=ForgePilot <no-reply@yourdomain.com>
```

Without it, emails are written to the log instead of being sent.

## 7. Workspace connectors (set by each customer in the app)

The app sends these to `POST /integrations/:providerId/connect` as `{ "account": "...", "credentials": { ... } }`. The credential is verified against the provider first, then encrypted.

| Provider       | `credentials` fields                    | Where the customer gets it                                            |
| -------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `claude_code`  | `apiKey`                                | console.anthropic.com → API keys                                      |
| `openai_codex` | `apiKey`                                | platform.openai.com → API keys                                        |
| `slack`        | `webhookUrl`, or `botToken` + `channel` | Slack app → Incoming Webhooks, or a bot token with `chat:write`       |
| `teams`        | `webhookUrl`                            | Teams channel → Workflows → incoming webhook                          |
| `linear`       | `apiKey`                                | Linear → Settings → API → Personal API keys                           |
| `jira`         | `baseUrl`, `email`, `apiToken`          | `https://yourcompany.atlassian.net` and id.atlassian.com → API tokens |

Agent workers also need the agent CLIs available. With `EXECUTION_SANDBOX=docker` (the default) build and publish two small images that contain them, named `forgepilot/agent-claude-code` and `forgepilot/agent-codex`, and give the worker access to Docker.

## Order to do it in

1. Database and vault key: the backend is then safe to deploy.
2. Email: invitations and password reset work.
3. Stripe in test mode: plans can be bought.
4. GitHub App, then `EXECUTION_MODE=live`: real repositories.
5. Connect one agent key in a test workspace and run one task end to end.

None of these connectors has been run against a real account yet. Do step 5 on a throwaway repository first and expect to fix small things.

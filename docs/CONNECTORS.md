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

Metered usage (optional): to bill agent and browser minutes beyond a plan's allowance, create a billing meter per usage type in Stripe (Billing → Meters), attach a metered price to the plan's product, and map the meter event names:

```
STRIPE_METERS={"agent_minutes":"fp_agent_minutes","browser_minutes":"fp_browser_minutes"}
```

Each completed day of usage is then sent once per workspace, around 03:00 UTC. Without this variable usage is still tracked and shown in the app, just not sent to Stripe.

To test webhooks on a laptop: `stripe listen --forward-to localhost:8080/api/v1/webhooks/stripe` and use the secret it prints.

Use a restricted key in production with write access to Customers, Checkout Sessions, Subscriptions and Customer portal only.

## 6. Email (Resend)

Used for invitations and password resets. Create an API key at resend.com and verify your sending domain.

```
RESEND_API_KEY=re_...
EMAIL_FROM=ForgePilot <no-reply@yourdomain.com>
```

Without it, emails are written to the log instead of being sent.

## 7. File storage for test evidence

Full test output (and later screenshots and traces) is kept as files. By default they go to a folder on the server's disk, which is fine for one machine. For production use a bucket on AWS S3 or any S3-compatible service (Cloudflare R2, MinIO):

```
ARTIFACT_STORE=s3
S3_BUCKET=forgepilot-artifacts
S3_REGION=us-east-1
# Only for S3-compatible services:
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Keep the bucket private. Files are stored under one folder per workspace and are removed by each workspace's retention setting and when a workspace is deleted.

## 8. Staff back-office

ForgePilot's own team (the "super admin" level, above every customer workspace) uses the `/admin` endpoints: find workspaces and users, suspend or restore a workspace, set an enterprise plan, retry failed jobs. List who is allowed:

```
PLATFORM_ADMIN_EMAILS=you@yourcompany.com,support@yourcompany.com
```

Each person signs up normally with that address, confirms it through the verification email, and turns on two-factor sign-in with an authenticator app (the back-office walks them through it). Until all three are done the back-office answers 404 for them, like it does for everyone else. Every staff action is recorded in `GET /admin/audit`, and suspensions and plan changes also appear in the customer's own audit log.

## 9. Single sign-on for enterprise customers

Nothing to configure on the platform. A customer on the Enterprise plan connects Okta or Microsoft Entra ID in Integrations with four values from an OpenID Connect app they create in their identity provider (redirect URL: `https://api.example.com/api/v1/auth/sso/callback`):

| `credentials` field        | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `issuer`                   | The provider's issuer URL, e.g. `https://company.okta.com` |
| `clientId`, `clientSecret` | From the OpenID Connect app                                |
| `domain`                   | Their email domain, e.g. `company.com`                     |

The claim then appears in the staff back-office under single sign-on domains. **Approve it only after confirming the customer really controls that domain**, because approval lets their identity provider sign people in for every address in it. Changing the settings needs a fresh approval.

## 10. Workspace connectors (set by each customer in the app)

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

1. Database, vault key and the staff list: the backend is then safe to deploy.
2. Email: invitations and password reset work.
3. Stripe in test mode: plans can be bought.
4. GitHub App, then `EXECUTION_MODE=live`: real repositories.
5. Connect one agent key in a test workspace and run one task end to end.

None of these connectors has been run against a real account yet. Do step 5 on a throwaway repository first and expect to fix small things.

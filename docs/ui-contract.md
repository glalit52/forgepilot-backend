# ForgePilot API contract

> Generated from `lib/mock/handlers.ts` and `lib/schemas`. Do not edit by hand —
> run `UPDATE_CONTRACT=1 pnpm test` to regenerate. `pnpm test` fails if this file is out of date.

Base URL: `/api/mock` today (set `NEXT_PUBLIC_API_BASE` for the real backend). JSON bodies.
Errors: `{ "error": string, "details"?: unknown }` with 400/401/402 (plan limit)/403/404/409/422.
Auth: mock cookies `fp_session` (user) and `fp_ws` (active workspace). Every route is scoped to the active workspace.

Guardrails the backend must enforce (not just the UI):

- **Tenant isolation:** records from another workspace return 404.
- **Least privilege:** permissions per route below; viewers are read-only; approvals need the approver role named on the request and requesters can't approve themselves.
- **No auto-merge:** passing checks set `review_ready`; merge state comes from GitHub.
- **Loop protection:** fix tasks per bug are capped by `policy.maxFixRetries`; retries are capped too.
- **Budgets:** with `hardCap`, launches are refused once the monthly budget is used (402).
- **Commit pinning:** every test run and scan records exact SHAs.

## Endpoints

| Method | Path | Auth | Request | Response | Summary |
| --- | --- | --- | --- | --- | --- |
| GET | `/session/personas` | None | — | see below | Demo personas for the sign-in screen. |
| GET | `/session/status` | None | — | see below | Whether the visitor is signed in and has a workspace (used by onboarding before a workspace exists). |
| GET | `/session` | Any workspace member | — | `SessionInfo` | Current user, active workspace, role, other workspaces and badge counts. |
| GET | `/visual-snapshots` | Any workspace member | — | `VisualSnapshotListItem[]` | Visual comparisons (baseline vs candidate). ?status= &pullRequestId= &runId= &repositoryId= |
| POST | `/visual-snapshots/:id/decision` | Permission `suite.manage` | `VisualDecisionInput` | `VisualSnapshot` | Approve a changed screenshot as the new baseline, or reject it (files a visual-regression bug). Decisions are explicit and audited. |
| GET | `/github/issues` | Any workspace member | — | `GithubIssueListItem[]` | Open issues in connected repositories, with what an import would produce. ?repositoryId= &q= &imported=true\|false |
| POST | `/github/issues/import` | Permission `task.create` | `ImportIssuesInput` | `ImportIssuesResult` | Import GitHub issues as DevPilot tasks: checklists become acceptance criteria, labels set priority. Already-imported issues are skipped. |
| POST | `/session` | None | `SignInInput` | `SessionInfo` | Sign in as a demo persona (sets fp_session and fp_ws cookies). |
| POST | `/session/workspace` | Any workspace member | `SwitchWorkspaceInput` | `SessionInfo` | Switch the active workspace. |
| POST | `/signup` | None | `SignUpInput` | `User` | Create an account (mock GitHub OAuth or email). The user then creates a workspace in onboarding. |
| POST | `/orgs` | None | `CreateWorkspaceInput` | `Organization` | Create a workspace for the signed-in user (owner, Free plan with a 14-day Team trial). |
| GET | `/github/repositories` | Any workspace member | — | `GithubRepoCandidate[]` | Repositories visible to the GitHub App installation (mock). ?account= |
| POST | `/github/install` | Permission `repo.connect` | `ConnectIntegrationInput` | `Integration` | Record the GitHub App installation for the workspace (mock). |
| POST | `/repositories/connect` | Permission `repo.connect` | `ConnectReposInput` | `ConnectReposResult` | Connect selected repositories to a project and start indexing (repository intelligence). |
| POST | `/repositories/:id/config` | Permission `repo.connect` | `RepoConfigInput` | `Repository` | Confirm discovered test commands and scan schedule. |
| POST | `/onboarding/first-run` | Permission `test.run` | `FirstRunInput` | `FirstRunResult` | Run the first ShipSafe test run or CodeKeeper scan for a repository. |
| GET | `/overview` | Any workspace member | — | `Overview` | Workspace overview: North Star, KPIs, lifecycle funnel, attention list, live sessions, activity, setup checklist. |
| GET | `/projects` | Any workspace member | — | `ProjectSummary[]` | Projects with health, PR, session and finding counts. |
| POST | `/projects` | Permission `repo.connect` | `NewProjectInput` | `Project` | Create a project. |
| GET | `/projects/:id` | Any workspace member | — | `ProjectDetail` | Project detail: repositories, tasks, PRs, runs and findings. |
| GET | `/repositories` | Any workspace member | — | `RepositorySummary[]` | Connected repositories. ?projectId= |
| GET | `/repositories/:id` | Any workspace member | — | `RepositoryDetail` | Repository detail: suites, findings, health history, scans, runs, PRs. |
| POST | `/repositories/:id/scans` | Permission `test.run` | — | `Scan` | Start a CodeKeeper scan of the repository. |
| GET | `/devpilot/overview` | Any workspace member | — | `DevPilotOverview` | DevPilot command centre: KPIs, board, live sessions, agents. |
| GET | `/tasks` | Any workspace member | — | `TaskListItem[]` | Tasks. Filters: status, projectId, repositoryId, source, agentId, q. |
| POST | `/tasks` | Permission `task.create` | `NewTaskInput` | `Task` | Create a task (optionally launch it). Validates policy, agent and budget. |
| GET | `/tasks/:id` | Any workspace member | — | `TaskDetail` | Task detail: sessions, approvals, PR, verification runs, linked bug/finding, lifecycle, activity, policy preview. |
| POST | `/tasks/:id/actions` | Permission `task.launch` | `TaskActionInput` | `TaskDetail` | launch \| cancel \| retry \| archive. Enforces the task state machine, retry cap and budget hard cap. |
| GET | `/sessions` | Any workspace member | — | `SessionListItem[]` | Agent sessions. ?status= |
| GET | `/sessions/:id` | Any workspace member | — | `SessionDetail` | Session detail with workspace, approvals and other attempts. |
| GET | `/sessions/:id/log` | Any workspace member | — | `LiveLog` | Structured, secret-redacted session log (poll every ~1.2s while running). |
| GET | `/sessions/:id/diff` | Any workspace member | — | `DiffFile[]` | Changed files with hunks for the session's commit. |
| POST | `/sessions/:id/cancel` | Permission `task.cancel` | — | `SessionListItem` | Cancel an active session; the worker is terminated and the workspace cleaned up. |
| GET | `/workspaces` | Any workspace member | — | see below | Isolated execution workspaces (one per session). |
| GET | `/agents` | Any workspace member | — | `Agent[]` | Configured coding-agent runtimes. |
| POST | `/agents/:id` | Permission `agent.manage` | see below | `Agent` | Update or suspend an agent runtime. |
| GET | `/shipsafe/overview` | Any workspace member | — | `ShipSafeOverview` | Testing dashboard: pass-rate trend, KPIs, failure classes, repositories, recent runs, open bugs. |
| GET | `/test-suites` | Any workspace member | — | see below | Test suites. ?repositoryId= |
| POST | `/test-suites` | Permission `suite.manage` | `TestSuiteInput` | `TestSuite` | Create a test suite. |
| POST | `/test-suites/:id` | Permission `suite.manage` | `TestSuitePatch` | `TestSuite` | Update a test suite (enable/disable, required, command, timeout). |
| GET | `/test-runs` | Any workspace member | — | `TestRunListItem[]` | Test runs. ?repositoryId= &status= &pullRequestId= &trigger= |
| POST | `/test-runs` | Permission `test.run` | `NewTestRunInput` | `TestRun` | Start a manual test run on a branch. |
| GET | `/test-runs/:id` | Any workspace member | — | `TestRunDetail` | Run detail: environment, commit pins, test plan with reasons, results, evidence, comparison with the previous run, worker log. |
| POST | `/test-runs/:id/rerun` | Permission `test.run` | — | `TestRun` | Rerun with the same commit pin (infra failures rerun free). |
| GET | `/bugs` | Any workspace member | — | `BugListItem[]` | Bugs from ShipSafe failures. ?status= &severity= |
| GET | `/bugs/:id` | Any workspace member | — | `BugDetail` | Bug detail with the failing result, evidence, run, PR and fix task. |
| POST | `/bugs/:id/actions` | Permission `bug.manage` | `BugActionInput` | `BugDetail` | create_fix_task (SS-012: preserves commit, logs and context; capped retries) \| resolve \| wont_fix \| reopen. |
| GET | `/pull-requests` | Any workspace member | — | `PullRequestListItem[]` | Pull requests (agent and human) with verification status. ?status= &author=agent\|person &repositoryId= &filter=review |
| GET | `/pull-requests/:id` | Any workspace member | — | `PullRequestDetail` | PR verification detail: runs, results, bugs, release policy and merge blockers. |
| GET | `/pull-requests/:id/diff` | Any workspace member | — | `DiffFile[]` | Diff for the PR head. |
| POST | `/pull-requests/:id/review` | Permission `pr.review` | `ReviewInput` | `PullRequestDetail` | Record a human review (mirrors the GitHub review). |
| POST | `/pull-requests/:id/merge` | Permission `pr.review` | — | `PullRequestDetail` | Demo only: simulate the GitHub merge webhook. Refused while required checks or review are missing. |
| GET | `/codekeeper/overview` | Any workspace member | — | `CodeKeeperOverview` | Repository health: average and trend, per-repository scores, findings breakdown, scans, maintenance PR acceptance, prioritised queue. |
| GET | `/dependencies` | Any workspace member | — | see below | Dependency inventory. ?repositoryId= &q= &filter=outdated\|vulnerable |
| GET | `/findings` | Any workspace member | — | `FindingListItem[]` | Maintenance findings. ?status= &severity= &category= &repositoryId= |
| GET | `/findings/:id` | Any workspace member | — | `FindingDetail` | Finding detail with advisory evidence, dependency and linked task. |
| POST | `/findings/:id/actions` | Permission `finding.create_task` | `FindingActionInput` | `FindingDetail` | create_task (policy-validated DevPilot maintenance task) \| suppress (reason + expiry, admins) \| unsuppress. |
| GET | `/approvals` | Any workspace member | — | see below | Approval centre. ?status= |
| POST | `/approvals/:id/decision` | Permission `approval.decide` | `ApprovalDecisionInput` | `Approval` | Approve or reject. Bound to the exact action and context; requester can't approve their own request. |
| POST | `/sessions/:id/input` | Permission `task.launch` | `SessionInput` | `SessionListItem` | Answer an agent's clarification question and resume the session. |
| GET | `/analytics` | Any workspace member | — | `Analytics` | Analytics (30/90 days): North Star, task success by type, providers (task-mix caveat), PR acceptance, test usefulness, cost per verified task. |
| GET | `/integrations` | Any workspace member | — | `IntegrationView[]` | Integration catalogue merged with this workspace's connections. |
| POST | `/integrations/:providerId/connect` | Permission `integration.manage` | `ConnectIntegrationInput` | `Integration` | Connect (mock OAuth / API key) an integration. Credentials live in the vault; only a reference is stored. |
| POST | `/integrations/:providerId/disconnect` | Permission `integration.manage` | — | `Ok` | Disconnect and revoke an integration. |
| POST | `/workspace` | Permission `workspace.manage` | `WorkspacePatch` | `Organization` | Rename the workspace. |
| GET | `/members` | Any workspace member | — | `Members` | Members, pending invitations and seats. |
| POST | `/members/invite` | Permission `member.manage` | `InviteInput` | `Invitation` | Invite a member (respects the plan's seat limit). |
| POST | `/invitations/:id/revoke` | Permission `member.manage` | — | `Ok` | Revoke a pending invitation. |
| POST | `/members/:userId/role` | Permission `member.manage` | `RoleChangeInput` | `Ok` | Change a member's role. Only owners can grant or remove owner; the last owner can't be demoted. |
| POST | `/members/:userId/remove` | Permission `member.manage` | — | `Ok` | Remove a member from the workspace. |
| GET | `/policy` | Any workspace member | — | `Policy` | Workspace policies: providers, protected paths, network, required checks, approval rules, retention. |
| POST | `/policy` | Permission `policy.manage` | `PolicyPatch` | `Policy` | Update workspace policies (Team plan and above). |
| GET | `/api-keys` | Any workspace member | — | `ApiKey[]` | API keys (prefix only; secrets are shown once at creation). |
| POST | `/api-keys` | Permission `apikey.manage` | `ApiKeyInput` | `ApiKeyCreated` | Create an API key. The secret is returned once. |
| POST | `/api-keys/:id/revoke` | Permission `apikey.manage` | — | `Ok` | Revoke an API key immediately. |
| GET | `/audit-logs` | Any workspace member | — | `ActivityItem[]` | Audit log of user, agent and system actions. ?actorType= &q= &limit= |
| GET | `/plans` | None | — | `Plan[]` | Public plan catalogue (pricing page). |
| GET | `/billing` | Any workspace member | — | `Billing` | Plan, metered usage vs quota, projected spend, budget, cost breakdowns and invoices. |
| POST | `/billing/plan` | Permission `billing.manage` | `ChangePlanInput` | `Billing` | Change plan or billing cycle (mock checkout). Enterprise is sales-assisted. |
| POST | `/billing/budget` | Permission `billing.manage` | `BudgetInput` | `Billing` | Set the monthly execution budget, hard cap and alert thresholds. |
| GET | `/notifications` | Any workspace member | — | `Notification[]` | Notifications for the active workspace. |
| POST | `/notifications/read` | Any workspace member | see below | `Ok` | Mark notifications read. Body { ids?: string[] }. |
| GET | `/search` | Any workspace member | — | `SearchResult[]` | Search projects, repositories, tasks, PRs, bugs, findings and sessions. ?q= |
| GET | `/auth/options` | None | — | `AuthOptions` | Which sign-in methods this API offers. The mock is always a demo; the real backend reports password and GitHub sign-in. |
| POST | `/auth/login` | None | `LoginInput` | `AuthResult` | Sign in with email and password (real backend). The demo has no passwords. |
| POST | `/auth/logout` | None | — | `Ok` | End the current session and clear the session cookies. |
| POST | `/demo/reset` | None | — | `Ok` | Reset all mock data to the seed (demo mode). |

## Endpoint details

### GET `/session/personas`

Demo personas for the sign-in screen.

- **Auth:** None
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "email": {
        "type": "string",
        "format": "email",
        "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
      },
      "title": {
        "default": "",
        "type": "string"
      },
      "githubLogin": {
        "type": "string"
      },
      "workspaces": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "orgId": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "role": {
              "type": "string",
              "enum": [
                "owner",
                "admin",
                "member",
                "viewer"
              ]
            }
          },
          "required": [
            "orgId",
            "name",
            "role"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "id",
      "name",
      "email",
      "title",
      "workspaces"
    ],
    "additionalProperties": false
  }
}
```

### GET `/session/status`

Whether the visitor is signed in and has a workspace (used by onboarding before a workspace exists).

- **Auth:** None
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "signedIn": {
      "type": "boolean"
    },
    "hasWorkspace": {
      "type": "boolean"
    },
    "name": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "signedIn",
    "hasWorkspace",
    "name"
  ],
  "additionalProperties": false
}
```

### GET `/session`

Current user, active workspace, role, other workspaces and badge counts.

- **Auth:** Any workspace member
- **Response 200:** [`SessionInfo`](#sessioninfo)

### GET `/visual-snapshots`

Visual comparisons (baseline vs candidate). ?status= &pullRequestId= &runId= &repositoryId=

- **Auth:** Any workspace member
- **Response 200:** [`VisualSnapshotListItem[]`](#visualsnapshotlistitem)

### POST `/visual-snapshots/:id/decision`

Approve a changed screenshot as the new baseline, or reject it (files a visual-regression bug). Decisions are explicit and audited.

- **Auth:** Permission `suite.manage`
- **Request body:** [`VisualDecisionInput`](#visualdecisioninput)
- **Response 200:** [`VisualSnapshot`](#visualsnapshot)

### GET `/github/issues`

Open issues in connected repositories, with what an import would produce. ?repositoryId= &q= &imported=true|false

- **Auth:** Any workspace member
- **Response 200:** [`GithubIssueListItem[]`](#githubissuelistitem)

### POST `/github/issues/import`

Import GitHub issues as DevPilot tasks: checklists become acceptance criteria, labels set priority. Already-imported issues are skipped.

- **Auth:** Permission `task.create`
- **Request body:** [`ImportIssuesInput`](#importissuesinput)
- **Response 200:** [`ImportIssuesResult`](#importissuesresult)

### POST `/session`

Sign in as a demo persona (sets fp_session and fp_ws cookies).

- **Auth:** None
- **Request body:** [`SignInInput`](#signininput)
- **Response 200:** [`SessionInfo`](#sessioninfo)

### POST `/session/workspace`

Switch the active workspace.

- **Auth:** Any workspace member
- **Request body:** [`SwitchWorkspaceInput`](#switchworkspaceinput)
- **Response 200:** [`SessionInfo`](#sessioninfo)

### POST `/signup`

Create an account (mock GitHub OAuth or email). The user then creates a workspace in onboarding.

- **Auth:** None
- **Request body:** [`SignUpInput`](#signupinput)
- **Response 200:** [`User`](#user)

### POST `/orgs`

Create a workspace for the signed-in user (owner, Free plan with a 14-day Team trial).

- **Auth:** None
- **Request body:** [`CreateWorkspaceInput`](#createworkspaceinput)
- **Response 200:** [`Organization`](#organization)

### GET `/github/repositories`

Repositories visible to the GitHub App installation (mock). ?account=

- **Auth:** Any workspace member
- **Response 200:** [`GithubRepoCandidate[]`](#githubrepocandidate)

### POST `/github/install`

Record the GitHub App installation for the workspace (mock).

- **Auth:** Permission `repo.connect`
- **Request body:** [`ConnectIntegrationInput`](#connectintegrationinput)
- **Response 200:** [`Integration`](#integration)

### POST `/repositories/connect`

Connect selected repositories to a project and start indexing (repository intelligence).

- **Auth:** Permission `repo.connect`
- **Request body:** [`ConnectReposInput`](#connectreposinput)
- **Response 200:** [`ConnectReposResult`](#connectreposresult)

### POST `/repositories/:id/config`

Confirm discovered test commands and scan schedule.

- **Auth:** Permission `repo.connect`
- **Request body:** [`RepoConfigInput`](#repoconfiginput)
- **Response 200:** [`Repository`](#repository)

### POST `/onboarding/first-run`

Run the first ShipSafe test run or CodeKeeper scan for a repository.

- **Auth:** Permission `test.run`
- **Request body:** [`FirstRunInput`](#firstruninput)
- **Response 200:** [`FirstRunResult`](#firstrunresult)

### GET `/overview`

Workspace overview: North Star, KPIs, lifecycle funnel, attention list, live sessions, activity, setup checklist.

- **Auth:** Any workspace member
- **Response 200:** [`Overview`](#overview)

### GET `/projects`

Projects with health, PR, session and finding counts.

- **Auth:** Any workspace member
- **Response 200:** [`ProjectSummary[]`](#projectsummary)

### POST `/projects`

Create a project.

- **Auth:** Permission `repo.connect`
- **Request body:** [`NewProjectInput`](#newprojectinput)
- **Response 200:** [`Project`](#project)

### GET `/projects/:id`

Project detail: repositories, tasks, PRs, runs and findings.

- **Auth:** Any workspace member
- **Response 200:** [`ProjectDetail`](#projectdetail)

### GET `/repositories`

Connected repositories. ?projectId=

- **Auth:** Any workspace member
- **Response 200:** [`RepositorySummary[]`](#repositorysummary)

### GET `/repositories/:id`

Repository detail: suites, findings, health history, scans, runs, PRs.

- **Auth:** Any workspace member
- **Response 200:** [`RepositoryDetail`](#repositorydetail)

### POST `/repositories/:id/scans`

Start a CodeKeeper scan of the repository.

- **Auth:** Permission `test.run`
- **Response 200:** [`Scan`](#scan)

### GET `/devpilot/overview`

DevPilot command centre: KPIs, board, live sessions, agents.

- **Auth:** Any workspace member
- **Response 200:** [`DevPilotOverview`](#devpilotoverview)

### GET `/tasks`

Tasks. Filters: status, projectId, repositoryId, source, agentId, q.

- **Auth:** Any workspace member
- **Response 200:** [`TaskListItem[]`](#tasklistitem)

### POST `/tasks`

Create a task (optionally launch it). Validates policy, agent and budget.

- **Auth:** Permission `task.create`
- **Request body:** [`NewTaskInput`](#newtaskinput)
- **Response 200:** [`Task`](#task)

### GET `/tasks/:id`

Task detail: sessions, approvals, PR, verification runs, linked bug/finding, lifecycle, activity, policy preview.

- **Auth:** Any workspace member
- **Response 200:** [`TaskDetail`](#taskdetail)

### POST `/tasks/:id/actions`

launch | cancel | retry | archive. Enforces the task state machine, retry cap and budget hard cap.

- **Auth:** Permission `task.launch`
- **Request body:** [`TaskActionInput`](#taskactioninput)
- **Response 200:** [`TaskDetail`](#taskdetail)

### GET `/sessions`

Agent sessions. ?status=

- **Auth:** Any workspace member
- **Response 200:** [`SessionListItem[]`](#sessionlistitem)

### GET `/sessions/:id`

Session detail with workspace, approvals and other attempts.

- **Auth:** Any workspace member
- **Response 200:** [`SessionDetail`](#sessiondetail)

### GET `/sessions/:id/log`

Structured, secret-redacted session log (poll every ~1.2s while running).

- **Auth:** Any workspace member
- **Response 200:** [`LiveLog`](#livelog)

### GET `/sessions/:id/diff`

Changed files with hunks for the session's commit.

- **Auth:** Any workspace member
- **Response 200:** [`DiffFile[]`](#difffile)

### POST `/sessions/:id/cancel`

Cancel an active session; the worker is terminated and the workspace cleaned up.

- **Auth:** Permission `task.cancel`
- **Response 200:** [`SessionListItem`](#sessionlistitem)

### GET `/workspaces`

Isolated execution workspaces (one per session).

- **Auth:** Any workspace member
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "sessionId": {
        "type": "string"
      },
      "orgId": {
        "type": "string"
      },
      "runtime": {
        "type": "string",
        "enum": [
          "container",
          "worktree"
        ]
      },
      "image": {
        "type": "string"
      },
      "state": {
        "type": "string",
        "enum": [
          "provisioning",
          "active",
          "cleaned"
        ]
      },
      "cpu": {
        "type": "number"
      },
      "memoryGb": {
        "type": "number"
      },
      "diskGb": {
        "type": "number"
      },
      "networkPolicy": {
        "type": "string",
        "enum": [
          "none",
          "allowlist",
          "open"
        ]
      },
      "createdAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
      },
      "cleanupAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
      },
      "credentials": {
        "type": "string"
      },
      "baseSha": {
        "type": "string",
        "pattern": "^[0-9a-f]{7,40}$"
      },
      "branch": {
        "type": "string"
      },
      "taskTitle": {
        "type": "string"
      },
      "sessionStatus": {
        "type": "string",
        "enum": [
          "queued",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled"
        ]
      },
      "repositoryName": {
        "type": "string"
      }
    },
    "required": [
      "id",
      "sessionId",
      "orgId",
      "runtime",
      "image",
      "state",
      "cpu",
      "memoryGb",
      "diskGb",
      "networkPolicy",
      "createdAt",
      "cleanupAt",
      "credentials",
      "baseSha",
      "branch",
      "taskTitle",
      "sessionStatus",
      "repositoryName"
    ],
    "additionalProperties": false
  }
}
```

### GET `/agents`

Configured coding-agent runtimes.

- **Auth:** Any workspace member
- **Response 200:** [`Agent[]`](#agent)

### POST `/agents/:id`

Update or suspend an agent runtime.

- **Auth:** Permission `agent.manage`
- **Request body:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "maxConcurrent": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50
    },
    "defaultBudgetUsd": {
      "type": "number",
      "minimum": 0
    },
    "defaultTimeoutMin": {
      "type": "number",
      "minimum": 5
    }
  },
  "additionalProperties": false
}
```
- **Response 200:** [`Agent`](#agent)

### GET `/shipsafe/overview`

Testing dashboard: pass-rate trend, KPIs, failure classes, repositories, recent runs, open bugs.

- **Auth:** Any workspace member
- **Response 200:** [`ShipSafeOverview`](#shipsafeoverview)

### GET `/test-suites`

Test suites. ?repositoryId=

- **Auth:** Any workspace member
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "repositoryId": {
        "type": "string"
      },
      "orgId": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "type": {
        "type": "string",
        "enum": [
          "unit",
          "playwright",
          "api"
        ]
      },
      "command": {
        "type": "string"
      },
      "environment": {
        "type": "string"
      },
      "pathRules": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "timeoutMin": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "owner": {
        "type": "string"
      },
      "enabled": {
        "type": "boolean"
      },
      "required": {
        "type": "boolean"
      },
      "flakyRatePct": {
        "type": "number",
        "minimum": 0
      },
      "testCount": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      },
      "repositoryName": {
        "type": "string"
      },
      "lastStatus": {
        "type": [
          "string",
          "null"
        ]
      }
    },
    "required": [
      "id",
      "repositoryId",
      "orgId",
      "name",
      "type",
      "command",
      "environment",
      "pathRules",
      "timeoutMin",
      "owner",
      "enabled",
      "required",
      "flakyRatePct",
      "testCount",
      "repositoryName",
      "lastStatus"
    ],
    "additionalProperties": false
  }
}
```

### POST `/test-suites`

Create a test suite.

- **Auth:** Permission `suite.manage`
- **Request body:** [`TestSuiteInput`](#testsuiteinput)
- **Response 200:** [`TestSuite`](#testsuite)

### POST `/test-suites/:id`

Update a test suite (enable/disable, required, command, timeout).

- **Auth:** Permission `suite.manage`
- **Request body:** [`TestSuitePatch`](#testsuitepatch)
- **Response 200:** [`TestSuite`](#testsuite)

### GET `/test-runs`

Test runs. ?repositoryId= &status= &pullRequestId= &trigger=

- **Auth:** Any workspace member
- **Response 200:** [`TestRunListItem[]`](#testrunlistitem)

### POST `/test-runs`

Start a manual test run on a branch.

- **Auth:** Permission `test.run`
- **Request body:** [`NewTestRunInput`](#newtestruninput)
- **Response 200:** [`TestRun`](#testrun)

### GET `/test-runs/:id`

Run detail: environment, commit pins, test plan with reasons, results, evidence, comparison with the previous run, worker log.

- **Auth:** Any workspace member
- **Response 200:** [`TestRunDetail`](#testrundetail)

### POST `/test-runs/:id/rerun`

Rerun with the same commit pin (infra failures rerun free).

- **Auth:** Permission `test.run`
- **Response 200:** [`TestRun`](#testrun)

### GET `/bugs`

Bugs from ShipSafe failures. ?status= &severity=

- **Auth:** Any workspace member
- **Response 200:** [`BugListItem[]`](#buglistitem)

### GET `/bugs/:id`

Bug detail with the failing result, evidence, run, PR and fix task.

- **Auth:** Any workspace member
- **Response 200:** [`BugDetail`](#bugdetail)

### POST `/bugs/:id/actions`

create_fix_task (SS-012: preserves commit, logs and context; capped retries) | resolve | wont_fix | reopen.

- **Auth:** Permission `bug.manage`
- **Request body:** [`BugActionInput`](#bugactioninput)
- **Response 200:** [`BugDetail`](#bugdetail)

### GET `/pull-requests`

Pull requests (agent and human) with verification status. ?status= &author=agent|person &repositoryId= &filter=review

- **Auth:** Any workspace member
- **Response 200:** [`PullRequestListItem[]`](#pullrequestlistitem)

### GET `/pull-requests/:id`

PR verification detail: runs, results, bugs, release policy and merge blockers.

- **Auth:** Any workspace member
- **Response 200:** [`PullRequestDetail`](#pullrequestdetail)

### GET `/pull-requests/:id/diff`

Diff for the PR head.

- **Auth:** Any workspace member
- **Response 200:** [`DiffFile[]`](#difffile)

### POST `/pull-requests/:id/review`

Record a human review (mirrors the GitHub review).

- **Auth:** Permission `pr.review`
- **Request body:** [`ReviewInput`](#reviewinput)
- **Response 200:** [`PullRequestDetail`](#pullrequestdetail)

### POST `/pull-requests/:id/merge`

Demo only: simulate the GitHub merge webhook. Refused while required checks or review are missing.

- **Auth:** Permission `pr.review`
- **Response 200:** [`PullRequestDetail`](#pullrequestdetail)

### GET `/codekeeper/overview`

Repository health: average and trend, per-repository scores, findings breakdown, scans, maintenance PR acceptance, prioritised queue.

- **Auth:** Any workspace member
- **Response 200:** [`CodeKeeperOverview`](#codekeeperoverview)

### GET `/dependencies`

Dependency inventory. ?repositoryId= &q= &filter=outdated|vulnerable

- **Auth:** Any workspace member
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "repositoryId": {
        "type": "string"
      },
      "orgId": {
        "type": "string"
      },
      "ecosystem": {
        "type": "string",
        "enum": [
          "npm",
          "pypi"
        ]
      },
      "name": {
        "type": "string"
      },
      "installedVersion": {
        "type": "string"
      },
      "latestVersion": {
        "type": "string"
      },
      "direct": {
        "type": "boolean"
      },
      "license": {
        "type": "string"
      },
      "manifest": {
        "type": "string"
      },
      "repositoryName": {
        "type": "string"
      },
      "outdated": {
        "type": "boolean"
      },
      "vulnerable": {
        "type": "boolean"
      },
      "majorBehind": {
        "type": "boolean"
      }
    },
    "required": [
      "id",
      "repositoryId",
      "orgId",
      "ecosystem",
      "name",
      "installedVersion",
      "latestVersion",
      "direct",
      "license",
      "manifest",
      "repositoryName",
      "outdated",
      "vulnerable",
      "majorBehind"
    ],
    "additionalProperties": false
  }
}
```

### GET `/findings`

Maintenance findings. ?status= &severity= &category= &repositoryId=

- **Auth:** Any workspace member
- **Response 200:** [`FindingListItem[]`](#findinglistitem)

### GET `/findings/:id`

Finding detail with advisory evidence, dependency and linked task.

- **Auth:** Any workspace member
- **Response 200:** [`FindingDetail`](#findingdetail)

### POST `/findings/:id/actions`

create_task (policy-validated DevPilot maintenance task) | suppress (reason + expiry, admins) | unsuppress.

- **Auth:** Permission `finding.create_task`
- **Request body:** [`FindingActionInput`](#findingactioninput)
- **Response 200:** [`FindingDetail`](#findingdetail)

### GET `/approvals`

Approval centre. ?status=

- **Auth:** Any workspace member
- **Response 200:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "orgId": {
        "type": "string"
      },
      "action": {
        "type": "string",
        "enum": [
          "modify_protected_path",
          "access_secret",
          "run_migration",
          "network_egress",
          "budget_increase",
          "create_pull_request",
          "deploy_production"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "pending",
          "approved",
          "rejected",
          "expired"
        ]
      },
      "title": {
        "type": "string"
      },
      "context": {
        "type": "object",
        "propertyNames": {
          "type": "string"
        },
        "additionalProperties": {}
      },
      "requestedBy": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "person",
              "agent"
            ]
          },
          "id": {
            "type": "string"
          },
          "sessionId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "type",
          "id",
          "sessionId"
        ],
        "additionalProperties": false
      },
      "requestedAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
      },
      "expiresAt": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
      },
      "approverRole": {
        "type": "string",
        "enum": [
          "owner",
          "admin",
          "member",
          "viewer"
        ]
      },
      "decidedBy": {
        "type": [
          "string",
          "null"
        ]
      },
      "decidedAt": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          {
            "type": "null"
          }
        ]
      },
      "comment": {
        "type": [
          "string",
          "null"
        ]
      },
      "requesterResolved": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "person",
              "agent",
              "system"
            ]
          },
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "detail": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "id",
          "name",
          "detail"
        ],
        "additionalProperties": false
      },
      "taskTitle": {
        "type": [
          "string",
          "null"
        ]
      },
      "canDecide": {
        "type": "boolean"
      }
    },
    "required": [
      "id",
      "orgId",
      "action",
      "status",
      "title",
      "context",
      "requestedBy",
      "requestedAt",
      "expiresAt",
      "approverRole",
      "decidedBy",
      "decidedAt",
      "comment",
      "requesterResolved",
      "taskTitle",
      "canDecide"
    ],
    "additionalProperties": false
  }
}
```

### POST `/approvals/:id/decision`

Approve or reject. Bound to the exact action and context; requester can't approve their own request.

- **Auth:** Permission `approval.decide`
- **Request body:** [`ApprovalDecisionInput`](#approvaldecisioninput)
- **Response 200:** [`Approval`](#approval)

### POST `/sessions/:id/input`

Answer an agent's clarification question and resume the session.

- **Auth:** Permission `task.launch`
- **Request body:** [`SessionInput`](#sessioninput)
- **Response 200:** [`SessionListItem`](#sessionlistitem)

### GET `/analytics`

Analytics (30/90 days): North Star, task success by type, providers (task-mix caveat), PR acceptance, test usefulness, cost per verified task.

- **Auth:** Any workspace member
- **Response 200:** [`Analytics`](#analytics)

### GET `/integrations`

Integration catalogue merged with this workspace's connections.

- **Auth:** Any workspace member
- **Response 200:** [`IntegrationView[]`](#integrationview)

### POST `/integrations/:providerId/connect`

Connect (mock OAuth / API key) an integration. Credentials live in the vault; only a reference is stored.

- **Auth:** Permission `integration.manage`
- **Request body:** [`ConnectIntegrationInput`](#connectintegrationinput)
- **Response 200:** [`Integration`](#integration)

### POST `/integrations/:providerId/disconnect`

Disconnect and revoke an integration.

- **Auth:** Permission `integration.manage`
- **Response 200:** [`Ok`](#ok)

### POST `/workspace`

Rename the workspace.

- **Auth:** Permission `workspace.manage`
- **Request body:** [`WorkspacePatch`](#workspacepatch)
- **Response 200:** [`Organization`](#organization)

### GET `/members`

Members, pending invitations and seats.

- **Auth:** Any workspace member
- **Response 200:** [`Members`](#members)

### POST `/members/invite`

Invite a member (respects the plan's seat limit).

- **Auth:** Permission `member.manage`
- **Request body:** [`InviteInput`](#inviteinput)
- **Response 200:** [`Invitation`](#invitation)

### POST `/invitations/:id/revoke`

Revoke a pending invitation.

- **Auth:** Permission `member.manage`
- **Response 200:** [`Ok`](#ok)

### POST `/members/:userId/role`

Change a member's role. Only owners can grant or remove owner; the last owner can't be demoted.

- **Auth:** Permission `member.manage`
- **Request body:** [`RoleChangeInput`](#rolechangeinput)
- **Response 200:** [`Ok`](#ok)

### POST `/members/:userId/remove`

Remove a member from the workspace.

- **Auth:** Permission `member.manage`
- **Response 200:** [`Ok`](#ok)

### GET `/policy`

Workspace policies: providers, protected paths, network, required checks, approval rules, retention.

- **Auth:** Any workspace member
- **Response 200:** [`Policy`](#policy)

### POST `/policy`

Update workspace policies (Team plan and above).

- **Auth:** Permission `policy.manage`
- **Request body:** [`PolicyPatch`](#policypatch)
- **Response 200:** [`Policy`](#policy)

### GET `/api-keys`

API keys (prefix only; secrets are shown once at creation).

- **Auth:** Any workspace member
- **Response 200:** [`ApiKey[]`](#apikey)

### POST `/api-keys`

Create an API key. The secret is returned once.

- **Auth:** Permission `apikey.manage`
- **Request body:** [`ApiKeyInput`](#apikeyinput)
- **Response 200:** [`ApiKeyCreated`](#apikeycreated)

### POST `/api-keys/:id/revoke`

Revoke an API key immediately.

- **Auth:** Permission `apikey.manage`
- **Response 200:** [`Ok`](#ok)

### GET `/audit-logs`

Audit log of user, agent and system actions. ?actorType= &q= &limit=

- **Auth:** Any workspace member
- **Response 200:** [`ActivityItem[]`](#activityitem)

### GET `/plans`

Public plan catalogue (pricing page).

- **Auth:** None
- **Response 200:** [`Plan[]`](#plan)

### GET `/billing`

Plan, metered usage vs quota, projected spend, budget, cost breakdowns and invoices.

- **Auth:** Any workspace member
- **Response 200:** [`Billing`](#billing)

### POST `/billing/plan`

Change plan or billing cycle (mock checkout). Enterprise is sales-assisted.

- **Auth:** Permission `billing.manage`
- **Request body:** [`ChangePlanInput`](#changeplaninput)
- **Response 200:** [`Billing`](#billing)

### POST `/billing/budget`

Set the monthly execution budget, hard cap and alert thresholds.

- **Auth:** Permission `billing.manage`
- **Request body:** [`BudgetInput`](#budgetinput)
- **Response 200:** [`Billing`](#billing)

### GET `/notifications`

Notifications for the active workspace.

- **Auth:** Any workspace member
- **Response 200:** [`Notification[]`](#notification)

### POST `/notifications/read`

Mark notifications read. Body { ids?: string[] }.

- **Auth:** Any workspace member
- **Request body:** 

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false
}
```
- **Response 200:** [`Ok`](#ok)

### GET `/search`

Search projects, repositories, tasks, PRs, bugs, findings and sessions. ?q=

- **Auth:** Any workspace member
- **Response 200:** [`SearchResult[]`](#searchresult)

### GET `/auth/options`

Which sign-in methods this API offers. The mock is always a demo; the real backend reports password and GitHub sign-in.

- **Auth:** None
- **Response 200:** [`AuthOptions`](#authoptions)

### POST `/auth/login`

Sign in with email and password (real backend). The demo has no passwords.

- **Auth:** None
- **Request body:** [`LoginInput`](#logininput)
- **Response 200:** [`AuthResult`](#authresult)

### POST `/auth/logout`

End the current session and clear the session cookies.

- **Auth:** None
- **Response 200:** [`Ok`](#ok)

### POST `/demo/reset`

Reset all mock data to the seed (demo mode).

- **Auth:** None
- **Response 200:** [`Ok`](#ok)

## Schemas

`$ref`s point at other schemas in this section.

### ActivityItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ActivityItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "actor": {
      "$ref": "#/schemas/ActorRef"
    },
    "action": {
      "type": "string"
    },
    "resource": {
      "type": "string"
    },
    "at": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "detail": {
      "type": "string"
    },
    "ip": {
      "type": [
        "string",
        "null"
      ]
    },
    "actorResolved": {
      "$ref": "#/schemas/ResolvedActor"
    },
    "label": {
      "type": "string"
    },
    "href": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "actor",
    "action",
    "resource",
    "at",
    "detail",
    "ip",
    "actorResolved",
    "label",
    "href"
  ],
  "additionalProperties": false
}
```

### ActorRef

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ActorRef",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "person"
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "agent"
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "system"
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ],
      "additionalProperties": false
    }
  ]
}
```

### Agent

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Agent",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "provider": {
      "$ref": "#/schemas/Provider"
    },
    "name": {
      "type": "string"
    },
    "model": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "maxConcurrent": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "defaultTimeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "defaultBudgetUsd": {
      "type": "number",
      "minimum": 0
    }
  },
  "required": [
    "id",
    "orgId",
    "provider",
    "name",
    "model",
    "status",
    "maxConcurrent",
    "defaultTimeoutMin",
    "defaultBudgetUsd"
  ],
  "additionalProperties": false
}
```

### Analytics

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Analytics",
  "type": "object",
  "properties": {
    "rangeDays": {
      "type": "number"
    },
    "northStar": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TrendPoint"
      }
    },
    "taskSuccessByType": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string"
          },
          "tasks": {
            "type": "number"
          },
          "successPct": {
            "type": "number"
          },
          "avgCostUsd": {
            "type": "number"
          },
          "reworkPct": {
            "type": "number"
          }
        },
        "required": [
          "category",
          "tasks",
          "successPct",
          "avgCostUsd",
          "reworkPct"
        ],
        "additionalProperties": false
      }
    },
    "providers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "provider": {
            "$ref": "#/schemas/Provider"
          },
          "sessions": {
            "type": "number"
          },
          "successPct": {
            "type": "number"
          },
          "avgMinutes": {
            "type": "number"
          },
          "costUsd": {
            "type": "number"
          },
          "humanInterventions": {
            "type": "number"
          }
        },
        "required": [
          "provider",
          "sessions",
          "successPct",
          "avgMinutes",
          "costUsd",
          "humanInterventions"
        ],
        "additionalProperties": false
      }
    },
    "prAcceptance": {
      "type": "object",
      "properties": {
        "agentPct": {
          "type": "number"
        },
        "humanPct": {
          "type": "number"
        },
        "agentMerged": {
          "type": "number"
        },
        "humanMerged": {
          "type": "number"
        }
      },
      "required": [
        "agentPct",
        "humanPct",
        "agentMerged",
        "humanMerged"
      ],
      "additionalProperties": false
    },
    "testUsefulness": {
      "type": "object",
      "properties": {
        "actionablePct": {
          "type": "number"
        },
        "reported": {
          "type": "number"
        },
        "falsePositive": {
          "type": "number"
        }
      },
      "required": [
        "actionablePct",
        "reported",
        "falsePositive"
      ],
      "additionalProperties": false
    },
    "timeToVerifyMinP50": {
      "type": "number"
    },
    "costPerVerifiedTaskUsd": {
      "type": "number"
    },
    "spendByDay": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string"
          },
          "agentUsd": {
            "type": "number"
          },
          "browserUsd": {
            "type": "number"
          }
        },
        "required": [
          "date",
          "agentUsd",
          "browserUsd"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "rangeDays",
    "northStar",
    "taskSuccessByType",
    "providers",
    "prAcceptance",
    "testUsefulness",
    "timeToVerifyMinP50",
    "costPerVerifiedTaskUsd",
    "spendByDay"
  ],
  "additionalProperties": false
}
```

### ApiKey

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApiKey",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "prefix": {
      "type": "string"
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "lastUsedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "name",
    "prefix",
    "scopes",
    "createdBy",
    "createdAt",
    "lastUsedAt"
  ],
  "additionalProperties": false
}
```

### ApiKeyCreated

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApiKeyCreated",
  "type": "object",
  "properties": {
    "key": {
      "$ref": "#/schemas/ApiKey"
    },
    "secret": {
      "type": "string"
    }
  },
  "required": [
    "key",
    "secret"
  ],
  "additionalProperties": false
}
```

### ApiKeyInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApiKeyInput",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 2
    },
    "scopes": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "name",
    "scopes"
  ],
  "additionalProperties": false
}
```

### Approval

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Approval",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "action": {
      "$ref": "#/schemas/ApprovalAction"
    },
    "status": {
      "$ref": "#/schemas/ApprovalStatus"
    },
    "title": {
      "type": "string"
    },
    "context": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "requestedBy": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "person",
            "agent"
          ]
        },
        "id": {
          "type": "string"
        },
        "sessionId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "type",
        "id",
        "sessionId"
      ],
      "additionalProperties": false
    },
    "requestedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "approverRole": {
      "$ref": "#/schemas/Role"
    },
    "decidedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "decidedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "comment": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "action",
    "status",
    "title",
    "context",
    "requestedBy",
    "requestedAt",
    "expiresAt",
    "approverRole",
    "decidedBy",
    "decidedAt",
    "comment"
  ],
  "additionalProperties": false
}
```

### ApprovalAction

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApprovalAction",
  "type": "string",
  "enum": [
    "modify_protected_path",
    "access_secret",
    "run_migration",
    "network_egress",
    "budget_increase",
    "create_pull_request",
    "deploy_production"
  ]
}
```

### ApprovalDecisionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApprovalDecisionInput",
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "approved",
        "rejected"
      ]
    },
    "comment": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "decision",
    "comment"
  ],
  "additionalProperties": false
}
```

### ApprovalRule

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApprovalRule",
  "type": "object",
  "properties": {
    "action": {
      "$ref": "#/schemas/ApprovalAction"
    },
    "mode": {
      "type": "string",
      "enum": [
        "allow",
        "require_approval",
        "prohibited"
      ]
    },
    "approverRole": {
      "$ref": "#/schemas/Role"
    }
  },
  "required": [
    "action",
    "mode",
    "approverRole"
  ],
  "additionalProperties": false
}
```

### ApprovalStatus

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ApprovalStatus",
  "type": "string",
  "enum": [
    "pending",
    "approved",
    "rejected",
    "expired"
  ]
}
```

### AttentionItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/AttentionItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "approval",
        "failed_check",
        "critical_finding",
        "budget",
        "integration",
        "review_ready",
        "waiting_input"
      ]
    },
    "title": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    },
    "href": {
      "type": "string"
    },
    "severity": {
      "type": "string",
      "enum": [
        "danger",
        "warning",
        "info"
      ]
    }
  },
  "required": [
    "id",
    "kind",
    "title",
    "detail",
    "href",
    "severity"
  ],
  "additionalProperties": false
}
```

### AuthOptions

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/AuthOptions",
  "type": "object",
  "properties": {
    "demo": {
      "type": "boolean"
    },
    "password": {
      "type": "boolean"
    },
    "github": {
      "type": "boolean"
    },
    "githubSignInUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "githubAppInstallUrl": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "demo",
    "password",
    "github",
    "githubSignInUrl",
    "githubAppInstallUrl"
  ],
  "additionalProperties": false
}
```

### AuthResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/AuthResult",
  "type": "object",
  "properties": {
    "user": {
      "$ref": "#/schemas/User"
    },
    "hasWorkspace": {
      "type": "boolean"
    }
  },
  "required": [
    "user",
    "hasWorkspace"
  ],
  "additionalProperties": false
}
```

### Billing

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Billing",
  "type": "object",
  "properties": {
    "plan": {
      "$ref": "#/schemas/PlanId"
    },
    "billingCycle": {
      "type": "string",
      "enum": [
        "monthly",
        "annual"
      ]
    },
    "seatsUsed": {
      "type": "number"
    },
    "seatsIncluded": {
      "type": [
        "number",
        "null"
      ]
    },
    "periodStart": {
      "type": "string"
    },
    "periodEnd": {
      "type": "string"
    },
    "subscriptionUsd": {
      "type": "number"
    },
    "usage": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/MeterUsage"
      }
    },
    "spend": {
      "type": "object",
      "properties": {
        "usageCostUsd": {
          "type": "number"
        },
        "projectedUsd": {
          "type": "number"
        },
        "budgetUsd": {
          "type": "number"
        },
        "hardCap": {
          "type": "boolean"
        },
        "alertAtPct": {
          "type": "array",
          "items": {
            "type": "number"
          }
        },
        "pctOfBudget": {
          "type": "number"
        }
      },
      "required": [
        "usageCostUsd",
        "projectedUsd",
        "budgetUsd",
        "hardCap",
        "alertAtPct",
        "pctOfBudget"
      ],
      "additionalProperties": false
    },
    "dailyCost": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string"
          },
          "costUsd": {
            "type": "number"
          }
        },
        "required": [
          "date",
          "costUsd"
        ],
        "additionalProperties": false
      }
    },
    "costByProject": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "projectId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "costUsd": {
            "type": "number"
          }
        },
        "required": [
          "projectId",
          "name",
          "costUsd"
        ],
        "additionalProperties": false
      }
    },
    "costByProvider": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "provider": {
            "type": "string"
          },
          "costUsd": {
            "type": "number"
          }
        },
        "required": [
          "provider",
          "costUsd"
        ],
        "additionalProperties": false
      }
    },
    "invoices": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Invoice"
      }
    },
    "paymentMethod": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "brand": {
              "type": "string"
            },
            "last4": {
              "type": "string"
            },
            "expires": {
              "type": "string"
            }
          },
          "required": [
            "brand",
            "last4",
            "expires"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "limits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "used": {
            "type": "number"
          },
          "limit": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "key",
          "label",
          "used",
          "limit"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "plan",
    "billingCycle",
    "seatsUsed",
    "seatsIncluded",
    "periodStart",
    "periodEnd",
    "subscriptionUsd",
    "usage",
    "spend",
    "dailyCost",
    "costByProject",
    "costByProvider",
    "invoices",
    "paymentMethod",
    "limits"
  ],
  "additionalProperties": false
}
```

### BudgetInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/BudgetInput",
  "type": "object",
  "properties": {
    "monthlyLimitUsd": {
      "type": "number",
      "minimum": 0,
      "maximum": 1000000
    },
    "hardCap": {
      "type": "boolean"
    },
    "alertAtPct": {
      "maxItems": 5,
      "type": "array",
      "items": {
        "type": "number",
        "minimum": 1,
        "maximum": 100
      }
    }
  },
  "required": [
    "monthlyLimitUsd",
    "hardCap",
    "alertAtPct"
  ],
  "additionalProperties": false
}
```

### Bug

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Bug",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "runId": {
      "type": "string"
    },
    "resultId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "title": {
      "type": "string"
    },
    "severity": {
      "$ref": "#/schemas/Severity"
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "fix_in_progress",
        "resolved",
        "wont_fix"
      ]
    },
    "commitSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "reproSteps": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "stackTrace": {
      "type": "string"
    },
    "suspectedCause": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "assigneeId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "runId",
    "resultId",
    "pullRequestId",
    "title",
    "severity",
    "status",
    "commitSha",
    "reproSteps",
    "stackTrace",
    "suspectedCause",
    "createdAt",
    "taskId",
    "assigneeId"
  ],
  "additionalProperties": false
}
```

### BugActionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/BugActionInput",
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "create_fix_task",
        "resolve",
        "wont_fix",
        "reopen"
      ]
    },
    "agentId": {
      "type": "string"
    },
    "comment": {
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

### BugDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/BugDetail",
  "type": "object",
  "properties": {
    "bug": {
      "$ref": "#/schemas/BugListItem"
    },
    "result": {
      "$ref": "#/schemas/TestResult"
    },
    "run": {
      "$ref": "#/schemas/TestRun"
    },
    "pullRequest": {
      "anyOf": [
        {
          "$ref": "#/schemas/PullRequest"
        },
        {
          "type": "null"
        }
      ]
    },
    "task": {
      "anyOf": [
        {
          "$ref": "#/schemas/Task"
        },
        {
          "type": "null"
        }
      ]
    },
    "repository": {
      "$ref": "#/schemas/Repository"
    }
  },
  "required": [
    "bug",
    "result",
    "run",
    "pullRequest",
    "task",
    "repository"
  ],
  "additionalProperties": false
}
```

### BugListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/BugListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "runId": {
      "type": "string"
    },
    "resultId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "title": {
      "type": "string"
    },
    "severity": {
      "$ref": "#/schemas/Severity"
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "fix_in_progress",
        "resolved",
        "wont_fix"
      ]
    },
    "commitSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "reproSteps": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "stackTrace": {
      "type": "string"
    },
    "suspectedCause": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "assigneeId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "pullRequestNumber": {
      "type": [
        "number",
        "null"
      ]
    },
    "testName": {
      "type": "string"
    },
    "taskStatus": {
      "anyOf": [
        {
          "$ref": "#/schemas/TaskStatus"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "runId",
    "resultId",
    "pullRequestId",
    "title",
    "severity",
    "status",
    "commitSha",
    "reproSteps",
    "stackTrace",
    "suspectedCause",
    "createdAt",
    "taskId",
    "assigneeId",
    "repositoryName",
    "pullRequestNumber",
    "testName",
    "taskStatus"
  ],
  "additionalProperties": false
}
```

### ChangePlanInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ChangePlanInput",
  "type": "object",
  "properties": {
    "plan": {
      "$ref": "#/schemas/PlanId"
    },
    "billingCycle": {
      "type": "string",
      "enum": [
        "monthly",
        "annual"
      ]
    }
  },
  "required": [
    "plan",
    "billingCycle"
  ],
  "additionalProperties": false
}
```

### ChangedFile

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ChangedFile",
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "additions": {
      "type": "number"
    },
    "deletions": {
      "type": "number"
    }
  },
  "required": [
    "path",
    "additions",
    "deletions"
  ],
  "additionalProperties": false
}
```

### CodeKeeperOverview

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/CodeKeeperOverview",
  "type": "object",
  "properties": {
    "avgHealth": {
      "type": [
        "number",
        "null"
      ]
    },
    "healthTrend": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TrendPoint"
      }
    },
    "repositories": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/RepositorySummary"
      }
    },
    "findingsBySeverity": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "number"
      }
    },
    "findingsByCategory": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "number"
      }
    },
    "recentScans": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "repositoryId": {
            "type": "string"
          },
          "orgId": {
            "type": "string"
          },
          "commitSha": {
            "type": "string",
            "pattern": "^[0-9a-f]{7,40}$"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "completed",
              "failed"
            ]
          },
          "trigger": {
            "type": "string",
            "enum": [
              "schedule",
              "push",
              "manual",
              "onboarding"
            ]
          },
          "startedAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
              },
              {
                "type": "null"
              }
            ]
          },
          "findingsCount": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "scoreAfter": {
            "type": [
              "number",
              "null"
            ]
          },
          "scoreDelta": {
            "type": [
              "number",
              "null"
            ]
          },
          "changes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "config": {
            "type": "object",
            "properties": {
              "ecosystems": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "checks": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "ecosystems",
              "checks"
            ],
            "additionalProperties": false
          },
          "simulatedEndsAt": {
            "type": "number"
          },
          "repositoryName": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "repositoryId",
          "orgId",
          "commitSha",
          "status",
          "trigger",
          "startedAt",
          "finishedAt",
          "findingsCount",
          "scoreAfter",
          "scoreDelta",
          "changes",
          "config",
          "repositoryName"
        ],
        "additionalProperties": false
      }
    },
    "maintenance": {
      "type": "object",
      "properties": {
        "prsCreated": {
          "type": "number"
        },
        "prsMerged": {
          "type": "number"
        },
        "acceptancePct": {
          "type": "number"
        },
        "inProgress": {
          "type": "number"
        }
      },
      "required": [
        "prsCreated",
        "prsMerged",
        "acceptancePct",
        "inProgress"
      ],
      "additionalProperties": false
    },
    "queue": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/FindingListItem"
      }
    }
  },
  "required": [
    "avgHealth",
    "healthTrend",
    "repositories",
    "findingsBySeverity",
    "findingsByCategory",
    "recentScans",
    "maintenance",
    "queue"
  ],
  "additionalProperties": false
}
```

### ConnectIntegrationInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ConnectIntegrationInput",
  "type": "object",
  "properties": {
    "account": {
      "type": "string",
      "minLength": 2
    },
    "installationId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "credentials": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      }
    }
  },
  "required": [
    "account"
  ],
  "additionalProperties": false
}
```

### ConnectReposInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ConnectReposInput",
  "type": "object",
  "properties": {
    "repositories": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "projectId": {
      "type": [
        "string",
        "null"
      ]
    },
    "newProjectName": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "repositories",
    "projectId",
    "newProjectName"
  ],
  "additionalProperties": false
}
```

### ConnectReposResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ConnectReposResult",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string"
    },
    "repositoryIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "projectId",
    "repositoryIds"
  ],
  "additionalProperties": false
}
```

### CreateWorkspaceInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/CreateWorkspaceInput",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 2,
      "maxLength": 48
    },
    "kind": {
      "$ref": "#/schemas/WorkspaceKind"
    },
    "useCase": {
      "type": "string",
      "enum": [
        "ship_ai_code_safely",
        "verify_prs",
        "maintain_repos",
        "coordinate_agents",
        "agency_client_repos",
        "personal_projects"
      ]
    }
  },
  "required": [
    "name",
    "kind",
    "useCase"
  ],
  "additionalProperties": false
}
```

### Dependency

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Dependency",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "ecosystem": {
      "type": "string",
      "enum": [
        "npm",
        "pypi"
      ]
    },
    "name": {
      "type": "string"
    },
    "installedVersion": {
      "type": "string"
    },
    "latestVersion": {
      "type": "string"
    },
    "direct": {
      "type": "boolean"
    },
    "license": {
      "type": "string"
    },
    "manifest": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "repositoryId",
    "orgId",
    "ecosystem",
    "name",
    "installedVersion",
    "latestVersion",
    "direct",
    "license",
    "manifest"
  ],
  "additionalProperties": false
}
```

### DevPilotOverview

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/DevPilotOverview",
  "type": "object",
  "properties": {
    "kpis": {
      "type": "object",
      "properties": {
        "running": {
          "type": "number"
        },
        "waiting": {
          "type": "number"
        },
        "reviewReady": {
          "type": "number"
        },
        "successRatePct": {
          "type": "number"
        },
        "avgCostUsd": {
          "type": "number"
        },
        "spend30dUsd": {
          "type": "number"
        }
      },
      "required": [
        "running",
        "waiting",
        "reviewReady",
        "successRatePct",
        "avgCostUsd",
        "spend30dUsd"
      ],
      "additionalProperties": false
    },
    "board": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "array",
        "items": {
          "$ref": "#/schemas/TaskListItem"
        }
      }
    },
    "liveSessions": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/SessionListItem"
      }
    },
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "orgId": {
            "type": "string"
          },
          "provider": {
            "$ref": "#/schemas/Provider"
          },
          "name": {
            "type": "string"
          },
          "model": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "suspended"
            ]
          },
          "maxConcurrent": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "defaultTimeoutMin": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "defaultBudgetUsd": {
            "type": "number",
            "minimum": 0
          },
          "running": {
            "type": "number"
          },
          "sessions30d": {
            "type": "number"
          },
          "successRatePct": {
            "type": "number"
          },
          "costUsd30d": {
            "type": "number"
          }
        },
        "required": [
          "id",
          "orgId",
          "provider",
          "name",
          "model",
          "status",
          "maxConcurrent",
          "defaultTimeoutMin",
          "defaultBudgetUsd",
          "running",
          "sessions30d",
          "successRatePct",
          "costUsd30d"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "kpis",
    "board",
    "liveSessions",
    "agents"
  ],
  "additionalProperties": false
}
```

### DiffFile

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/DiffFile",
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "modified",
        "added",
        "deleted"
      ]
    },
    "additions": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "deletions": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "aiAuthored": {
      "type": "boolean"
    },
    "lines": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/DiffLine"
      }
    }
  },
  "required": [
    "path",
    "status",
    "additions",
    "deletions",
    "aiAuthored",
    "lines"
  ],
  "additionalProperties": false
}
```

### DiffLine

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/DiffLine",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "context",
        "add",
        "del",
        "hunk"
      ]
    },
    "oldNo": {
      "type": [
        "number",
        "null"
      ]
    },
    "newNo": {
      "type": [
        "number",
        "null"
      ]
    },
    "text": {
      "type": "string"
    }
  },
  "required": [
    "kind",
    "oldNo",
    "newNo",
    "text"
  ],
  "additionalProperties": false
}
```

### EvidenceRef

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/EvidenceRef",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "screenshot",
        "trace",
        "console",
        "network",
        "log",
        "video"
      ]
    },
    "label": {
      "type": "string"
    },
    "ref": {
      "type": "string"
    }
  },
  "required": [
    "kind",
    "label",
    "ref"
  ],
  "additionalProperties": false
}
```

### FailureClass

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FailureClass",
  "type": "string",
  "enum": [
    "product_defect",
    "test_defect",
    "environment",
    "flaky",
    "infrastructure"
  ]
}
```

### Finding

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Finding",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "category": {
      "$ref": "#/schemas/FindingCategory"
    },
    "severity": {
      "$ref": "#/schemas/Severity"
    },
    "title": {
      "type": "string"
    },
    "package": {
      "type": [
        "string",
        "null"
      ]
    },
    "dependencyId": {
      "type": [
        "string",
        "null"
      ]
    },
    "affectedVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "fixedVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "advisoryId": {
      "type": [
        "string",
        "null"
      ]
    },
    "advisorySource": {
      "type": [
        "string",
        "null"
      ]
    },
    "sourceUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "confidence": {
      "type": "string",
      "enum": [
        "high",
        "medium",
        "low"
      ]
    },
    "riskBand": {
      "type": "string",
      "enum": [
        "urgent",
        "high",
        "medium",
        "low"
      ]
    },
    "status": {
      "$ref": "#/schemas/FindingStatus"
    },
    "detectedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "lastSeenSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "evidence": {
      "type": "string"
    },
    "suppression": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string"
            },
            "by": {
              "type": "string"
            },
            "at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
            }
          },
          "required": [
            "reason",
            "by",
            "at",
            "expiresAt"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "repositoryId",
    "orgId",
    "category",
    "severity",
    "title",
    "package",
    "dependencyId",
    "affectedVersion",
    "fixedVersion",
    "advisoryId",
    "advisorySource",
    "sourceUrl",
    "confidence",
    "riskBand",
    "status",
    "detectedAt",
    "lastSeenSha",
    "evidence",
    "suppression",
    "taskId"
  ],
  "additionalProperties": false
}
```

### FindingActionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FindingActionInput",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "create_task"
        },
        "agentId": {
          "type": "string"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "suppress"
        },
        "reason": {
          "type": "string",
          "minLength": 5
        },
        "expiresInDays": {
          "type": "integer",
          "minimum": 1,
          "maximum": 365
        }
      },
      "required": [
        "action",
        "reason",
        "expiresInDays"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "unsuppress"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    }
  ]
}
```

### FindingCategory

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FindingCategory",
  "type": "string",
  "enum": [
    "vulnerability",
    "outdated",
    "build",
    "tests",
    "docs"
  ]
}
```

### FindingDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FindingDetail",
  "type": "object",
  "properties": {
    "finding": {
      "$ref": "#/schemas/FindingListItem"
    },
    "dependency": {
      "anyOf": [
        {
          "$ref": "#/schemas/Dependency"
        },
        {
          "type": "null"
        }
      ]
    },
    "repository": {
      "$ref": "#/schemas/Repository"
    },
    "task": {
      "anyOf": [
        {
          "$ref": "#/schemas/TaskListItem"
        },
        {
          "type": "null"
        }
      ]
    },
    "similar": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/FindingListItem"
      }
    }
  },
  "required": [
    "finding",
    "dependency",
    "repository",
    "task",
    "similar"
  ],
  "additionalProperties": false
}
```

### FindingListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FindingListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "category": {
      "$ref": "#/schemas/FindingCategory"
    },
    "severity": {
      "$ref": "#/schemas/Severity"
    },
    "title": {
      "type": "string"
    },
    "package": {
      "type": [
        "string",
        "null"
      ]
    },
    "dependencyId": {
      "type": [
        "string",
        "null"
      ]
    },
    "affectedVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "fixedVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "advisoryId": {
      "type": [
        "string",
        "null"
      ]
    },
    "advisorySource": {
      "type": [
        "string",
        "null"
      ]
    },
    "sourceUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "confidence": {
      "type": "string",
      "enum": [
        "high",
        "medium",
        "low"
      ]
    },
    "riskBand": {
      "type": "string",
      "enum": [
        "urgent",
        "high",
        "medium",
        "low"
      ]
    },
    "status": {
      "$ref": "#/schemas/FindingStatus"
    },
    "detectedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "lastSeenSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "evidence": {
      "type": "string"
    },
    "suppression": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string"
            },
            "by": {
              "type": "string"
            },
            "at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
            }
          },
          "required": [
            "reason",
            "by",
            "at",
            "expiresAt"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "projectName": {
      "type": "string"
    },
    "taskStatus": {
      "anyOf": [
        {
          "$ref": "#/schemas/TaskStatus"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "repositoryId",
    "orgId",
    "category",
    "severity",
    "title",
    "package",
    "dependencyId",
    "affectedVersion",
    "fixedVersion",
    "advisoryId",
    "advisorySource",
    "sourceUrl",
    "confidence",
    "riskBand",
    "status",
    "detectedAt",
    "lastSeenSha",
    "evidence",
    "suppression",
    "taskId",
    "repositoryName",
    "projectName",
    "taskStatus"
  ],
  "additionalProperties": false
}
```

### FindingStatus

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FindingStatus",
  "type": "string",
  "enum": [
    "open",
    "task_created",
    "suppressed",
    "resolved"
  ]
}
```

### FirstRunInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FirstRunInput",
  "type": "object",
  "properties": {
    "repositoryId": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "test",
        "scan"
      ]
    }
  },
  "required": [
    "repositoryId",
    "kind"
  ],
  "additionalProperties": false
}
```

### FirstRunResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/FirstRunResult",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "test",
        "scan"
      ]
    },
    "id": {
      "type": "string"
    },
    "href": {
      "type": "string"
    }
  },
  "required": [
    "kind",
    "id",
    "href"
  ],
  "additionalProperties": false
}
```

### GithubIssueListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/GithubIssueListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "number": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "title": {
      "type": "string"
    },
    "body": {
      "type": "string"
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "author": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "state": {
      "type": "string",
      "enum": [
        "open",
        "closed"
      ]
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "comments": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "importedTaskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "authorUser": {
      "anyOf": [
        {
          "$ref": "#/schemas/User"
        },
        {
          "type": "null"
        }
      ]
    },
    "importedTaskStatus": {
      "anyOf": [
        {
          "$ref": "#/schemas/TaskStatus"
        },
        {
          "type": "null"
        }
      ]
    },
    "suggestedPriority": {
      "$ref": "#/schemas/Priority"
    },
    "suggestedCriteria": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "number",
    "title",
    "body",
    "labels",
    "author",
    "createdAt",
    "state",
    "url",
    "comments",
    "importedTaskId",
    "repositoryName",
    "authorUser",
    "importedTaskStatus",
    "suggestedPriority",
    "suggestedCriteria"
  ],
  "additionalProperties": false
}
```

### GithubRepoCandidate

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/GithubRepoCandidate",
  "type": "object",
  "properties": {
    "fullName": {
      "type": "string"
    },
    "private": {
      "type": "boolean"
    },
    "language": {
      "type": "string"
    },
    "defaultBranch": {
      "type": "string"
    },
    "pushedAt": {
      "type": "string"
    },
    "alreadyConnected": {
      "type": "boolean"
    }
  },
  "required": [
    "fullName",
    "private",
    "language",
    "defaultBranch",
    "pushedAt",
    "alreadyConnected"
  ],
  "additionalProperties": false
}
```

### Health

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Health",
  "type": "object",
  "properties": {
    "score": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
    },
    "scoreVersion": {
      "type": "string"
    },
    "dependencies": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    },
    "security": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    },
    "buildStability": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    },
    "tests": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    },
    "docs": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "score",
    "scoreVersion",
    "dependencies",
    "security",
    "buildStability",
    "tests",
    "docs"
  ],
  "additionalProperties": false
}
```

### HealthSnapshot

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/HealthSnapshot",
  "type": "object",
  "properties": {
    "repositoryId": {
      "type": "string"
    },
    "weekStart": {
      "type": "string",
      "format": "date",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
    },
    "score": {
      "type": "number"
    }
  },
  "required": [
    "repositoryId",
    "weekStart",
    "score"
  ],
  "additionalProperties": false
}
```

### ImportIssuesInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ImportIssuesInput",
  "type": "object",
  "properties": {
    "issueIds": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "agentId": {
      "type": "string",
      "minLength": 1
    },
    "launch": {
      "type": "boolean"
    }
  },
  "required": [
    "issueIds",
    "agentId",
    "launch"
  ],
  "additionalProperties": false
}
```

### ImportIssuesResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ImportIssuesResult",
  "type": "object",
  "properties": {
    "tasks": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Task"
      }
    },
    "skipped": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "tasks",
    "skipped"
  ],
  "additionalProperties": false
}
```

### Integration

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Integration",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "providerId": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "connected",
        "disconnected",
        "error"
      ]
    },
    "account": {
      "type": "string"
    },
    "connectedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "error": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "orgId",
    "providerId",
    "status",
    "account",
    "connectedAt",
    "scopes"
  ],
  "additionalProperties": false
}
```

### IntegrationCategory

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/IntegrationCategory",
  "type": "string",
  "enum": [
    "source_control",
    "agents",
    "issues",
    "notifications",
    "observability",
    "security",
    "identity"
  ]
}
```

### IntegrationView

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/IntegrationView",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "category": {
      "$ref": "#/schemas/IntegrationCategory"
    },
    "description": {
      "type": "string"
    },
    "availability": {
      "type": "string",
      "enum": [
        "available",
        "beta",
        "coming_soon",
        "enterprise"
      ]
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "monogram": {
      "type": "string"
    },
    "connection": {
      "anyOf": [
        {
          "$ref": "#/schemas/Integration"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "providerId",
    "name",
    "category",
    "description",
    "availability",
    "scopes",
    "monogram",
    "connection"
  ],
  "additionalProperties": false
}
```

### Invitation

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Invitation",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "role": {
      "$ref": "#/schemas/Role"
    },
    "invitedBy": {
      "type": "string"
    },
    "sentAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "accepted",
        "revoked"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "email",
    "role",
    "invitedBy",
    "sentAt",
    "status"
  ],
  "additionalProperties": false
}
```

### InviteInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/InviteInput",
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "role": {
      "type": "string",
      "enum": [
        "admin",
        "member",
        "viewer"
      ]
    }
  },
  "required": [
    "email",
    "role"
  ],
  "additionalProperties": false
}
```

### Invoice

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Invoice",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "period": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "paid",
        "open",
        "void"
      ]
    },
    "subscriptionUsd": {
      "type": "number"
    },
    "usageUsd": {
      "type": "number"
    },
    "totalUsd": {
      "type": "number"
    },
    "issuedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "required": [
    "id",
    "orgId",
    "period",
    "status",
    "subscriptionUsd",
    "usageUsd",
    "totalUsd",
    "issuedAt"
  ],
  "additionalProperties": false
}
```

### LifecycleStep

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/LifecycleStep",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "enum": [
        "plan",
        "execute",
        "propose",
        "verify",
        "remediate",
        "review",
        "merge",
        "maintain"
      ]
    },
    "label": {
      "type": "string"
    },
    "state": {
      "type": "string",
      "enum": [
        "done",
        "current",
        "upcoming",
        "failed",
        "skipped"
      ]
    },
    "detail": {
      "type": [
        "string",
        "null"
      ]
    },
    "href": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "key",
    "label",
    "state",
    "detail",
    "href"
  ],
  "additionalProperties": false
}
```

### LiveLog

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/LiveLog",
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string"
    },
    "status": {
      "type": "string"
    },
    "lines": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/LogLine"
      }
    },
    "progressPct": {
      "type": "number"
    },
    "redactions": {
      "type": "number"
    }
  },
  "required": [
    "sessionId",
    "status",
    "lines",
    "progressPct",
    "redactions"
  ],
  "additionalProperties": false
}
```

### LogLine

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/LogLine",
  "type": "object",
  "properties": {
    "seq": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "at": {
      "type": "string"
    },
    "level": {
      "type": "string",
      "enum": [
        "info",
        "tool",
        "warn",
        "error",
        "success",
        "approval"
      ]
    },
    "text": {
      "type": "string"
    }
  },
  "required": [
    "seq",
    "at",
    "level",
    "text"
  ],
  "additionalProperties": false
}
```

### LoginInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/LoginInput",
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "email",
    "password"
  ],
  "additionalProperties": false
}
```

### Member

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Member",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "title": {
      "default": "",
      "type": "string"
    },
    "githubLogin": {
      "type": "string"
    },
    "role": {
      "$ref": "#/schemas/Role"
    },
    "joinedAt": {
      "type": "string"
    },
    "lastActiveAt": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "title",
    "role",
    "joinedAt",
    "lastActiveAt"
  ],
  "additionalProperties": false
}
```

### Members

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Members",
  "type": "object",
  "properties": {
    "members": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Member"
      }
    },
    "invitations": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Invitation"
      }
    },
    "seatsPurchased": {
      "type": "number"
    },
    "seatsIncluded": {
      "type": [
        "number",
        "null"
      ]
    }
  },
  "required": [
    "members",
    "invitations",
    "seatsPurchased",
    "seatsIncluded"
  ],
  "additionalProperties": false
}
```

### Meter

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Meter",
  "type": "string",
  "enum": [
    "agent_minutes",
    "browser_minutes",
    "test_runs",
    "scan_runs",
    "storage_gb"
  ]
}
```

### MeterUsage

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/MeterUsage",
  "type": "object",
  "properties": {
    "meter": {
      "$ref": "#/schemas/Meter"
    },
    "label": {
      "type": "string"
    },
    "unit": {
      "type": "string"
    },
    "used": {
      "type": "number"
    },
    "included": {
      "type": [
        "number",
        "null"
      ]
    },
    "projected": {
      "type": "number"
    },
    "overageUnits": {
      "type": "number"
    },
    "overageUsd": {
      "type": "number"
    },
    "unitPriceUsd": {
      "type": "number"
    }
  },
  "required": [
    "meter",
    "label",
    "unit",
    "used",
    "included",
    "projected",
    "overageUnits",
    "overageUsd",
    "unitPriceUsd"
  ],
  "additionalProperties": false
}
```

### NewProjectInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/NewProjectInput",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 2
    },
    "description": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "name",
    "description"
  ],
  "additionalProperties": false
}
```

### NewTaskInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/NewTaskInput",
  "type": "object",
  "properties": {
    "repositoryId": {
      "type": "string",
      "minLength": 1
    },
    "title": {
      "type": "string",
      "minLength": 5,
      "maxLength": 140
    },
    "description": {
      "type": "string",
      "minLength": 15
    },
    "acceptanceCriteria": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 3
      }
    },
    "constraints": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 3
      }
    },
    "priority": {
      "$ref": "#/schemas/Priority"
    },
    "agentId": {
      "type": "string",
      "minLength": 1
    },
    "targetBranch": {
      "type": "string",
      "minLength": 1
    },
    "budgetUsd": {
      "type": "number",
      "minimum": 0.5,
      "maximum": 200
    },
    "timeoutMin": {
      "type": "number",
      "minimum": 5,
      "maximum": 240
    },
    "launch": {
      "type": "boolean"
    },
    "source": {
      "default": "manual",
      "type": "string",
      "enum": [
        "manual",
        "github_issue",
        "linear",
        "jira",
        "shipsafe_failure",
        "codekeeper_finding"
      ]
    },
    "sourceRef": {
      "default": null,
      "type": [
        "string",
        "null"
      ]
    },
    "bugId": {
      "default": null,
      "type": [
        "string",
        "null"
      ]
    },
    "findingId": {
      "default": null,
      "type": [
        "string",
        "null"
      ]
    },
    "parentTaskId": {
      "default": null,
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "repositoryId",
    "title",
    "description",
    "acceptanceCriteria",
    "constraints",
    "priority",
    "agentId",
    "targetBranch",
    "budgetUsd",
    "timeoutMin",
    "launch",
    "source",
    "sourceRef",
    "bugId",
    "findingId",
    "parentTaskId"
  ],
  "additionalProperties": false
}
```

### NewTestRunInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/NewTestRunInput",
  "type": "object",
  "properties": {
    "repositoryId": {
      "type": "string",
      "minLength": 1
    },
    "branch": {
      "default": "main",
      "type": "string",
      "minLength": 1
    },
    "simulateFailure": {
      "type": "boolean"
    }
  },
  "required": [
    "repositoryId",
    "branch"
  ],
  "additionalProperties": false
}
```

### Notification

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Notification",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "userId": {
      "type": [
        "string",
        "null"
      ]
    },
    "kind": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "body": {
      "type": "string"
    },
    "href": {
      "type": "string"
    },
    "at": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "read": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "orgId",
    "userId",
    "kind",
    "title",
    "body",
    "href",
    "at",
    "read"
  ],
  "additionalProperties": false
}
```

### Ok

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Ok",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

### Organization

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Organization",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "slug": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "kind": {
      "$ref": "#/schemas/WorkspaceKind"
    },
    "plan": {
      "$ref": "#/schemas/PlanId"
    },
    "billingCycle": {
      "type": "string",
      "enum": [
        "monthly",
        "annual"
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "useCase": {
      "type": "string"
    },
    "seatsPurchased": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "budget": {
      "type": "object",
      "properties": {
        "monthlyLimitUsd": {
          "type": "number",
          "minimum": 0
        },
        "hardCap": {
          "type": "boolean"
        },
        "alertAtPct": {
          "type": "array",
          "items": {
            "type": "number"
          }
        }
      },
      "required": [
        "monthlyLimitUsd",
        "hardCap",
        "alertAtPct"
      ],
      "additionalProperties": false
    },
    "trialEndsAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "slug",
    "name",
    "kind",
    "plan",
    "billingCycle",
    "createdAt",
    "useCase",
    "seatsPurchased",
    "budget",
    "trialEndsAt"
  ],
  "additionalProperties": false
}
```

### Overview

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Overview",
  "type": "object",
  "properties": {
    "northStar": {
      "type": "object",
      "properties": {
        "value": {
          "type": "number"
        },
        "previous": {
          "type": "number"
        },
        "weekly": {
          "type": "array",
          "items": {
            "$ref": "#/schemas/TrendPoint"
          }
        }
      },
      "required": [
        "value",
        "previous",
        "weekly"
      ],
      "additionalProperties": false
    },
    "kpis": {
      "type": "object",
      "properties": {
        "activeSessions": {
          "type": "number"
        },
        "prsAwaitingReview": {
          "type": "number"
        },
        "verificationCoveragePct": {
          "type": "number"
        },
        "openBugs": {
          "type": "number"
        },
        "avgHealth": {
          "type": [
            "number",
            "null"
          ]
        },
        "passRatePct": {
          "type": "number"
        },
        "spendUsd": {
          "type": "number"
        },
        "budgetUsd": {
          "type": "number"
        }
      },
      "required": [
        "activeSessions",
        "prsAwaitingReview",
        "verificationCoveragePct",
        "openBugs",
        "avgHealth",
        "passRatePct",
        "spendUsd",
        "budgetUsd"
      ],
      "additionalProperties": false
    },
    "lifecycle": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "count": {
            "type": "number"
          },
          "href": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "label",
          "count",
          "href"
        ],
        "additionalProperties": false
      }
    },
    "attention": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/AttentionItem"
      }
    },
    "activity": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ActivityItem"
      }
    },
    "liveSessions": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/SessionListItem"
      }
    },
    "modules": {
      "type": "object",
      "properties": {
        "devpilot": {
          "type": "object",
          "properties": {
            "running": {
              "type": "number"
            },
            "reviewReady": {
              "type": "number"
            },
            "successRatePct": {
              "type": "number"
            }
          },
          "required": [
            "running",
            "reviewReady",
            "successRatePct"
          ],
          "additionalProperties": false
        },
        "shipsafe": {
          "type": "object",
          "properties": {
            "runsToday": {
              "type": "number"
            },
            "passRatePct": {
              "type": "number"
            },
            "openBugs": {
              "type": "number"
            }
          },
          "required": [
            "runsToday",
            "passRatePct",
            "openBugs"
          ],
          "additionalProperties": false
        },
        "codekeeper": {
          "type": "object",
          "properties": {
            "avgHealth": {
              "type": [
                "number",
                "null"
              ]
            },
            "openFindings": {
              "type": "number"
            },
            "critical": {
              "type": "number"
            }
          },
          "required": [
            "avgHealth",
            "openFindings",
            "critical"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "devpilot",
        "shipsafe",
        "codekeeper"
      ],
      "additionalProperties": false
    },
    "setup": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "done": {
            "type": "boolean"
          },
          "href": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "label",
          "done",
          "href"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "northStar",
    "kpis",
    "lifecycle",
    "attention",
    "activity",
    "liveSessions",
    "modules",
    "setup"
  ],
  "additionalProperties": false
}
```

### Plan

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Plan",
  "type": "object",
  "properties": {
    "id": {
      "$ref": "#/schemas/PlanId"
    },
    "name": {
      "type": "string"
    },
    "priceMonthlyUsd": {
      "type": [
        "number",
        "null"
      ]
    },
    "priceAnnualMonthlyUsd": {
      "type": [
        "number",
        "null"
      ]
    },
    "tagline": {
      "type": "string"
    },
    "audience": {
      "type": "string"
    },
    "highlighted": {
      "type": "boolean"
    },
    "limits": {
      "type": "object",
      "properties": {
        "projects": {
          "type": [
            "number",
            "null"
          ]
        },
        "repositories": {
          "type": [
            "number",
            "null"
          ]
        },
        "seats": {
          "type": [
            "number",
            "null"
          ]
        },
        "agentMinutes": {
          "type": [
            "number",
            "null"
          ]
        },
        "browserMinutes": {
          "type": [
            "number",
            "null"
          ]
        },
        "testRuns": {
          "type": [
            "number",
            "null"
          ]
        },
        "historyDays": {
          "type": [
            "number",
            "null"
          ]
        },
        "concurrentSessions": {
          "type": [
            "number",
            "null"
          ]
        }
      },
      "required": [
        "projects",
        "repositories",
        "seats",
        "agentMinutes",
        "browserMinutes",
        "testRuns",
        "historyDays",
        "concurrentSessions"
      ],
      "additionalProperties": false
    },
    "features": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "id",
    "name",
    "priceMonthlyUsd",
    "priceAnnualMonthlyUsd",
    "tagline",
    "audience",
    "highlighted",
    "limits",
    "features"
  ],
  "additionalProperties": false
}
```

### PlanId

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PlanId",
  "type": "string",
  "enum": [
    "free",
    "developer",
    "pro",
    "team",
    "business",
    "enterprise"
  ]
}
```

### Policy

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Policy",
  "type": "object",
  "properties": {
    "orgId": {
      "type": "string"
    },
    "allowedProviders": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Provider"
      }
    },
    "requirePrApproval": {
      "type": "boolean"
    },
    "protectedPaths": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "networkAllowlist": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "requiredChecks": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "maxFixRetries": {
      "type": "integer",
      "minimum": 0,
      "maximum": 10
    },
    "sessionTimeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "approvalRules": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ApprovalRule"
      }
    },
    "suppressionMaxDays": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "retentionDays": {
      "type": "object",
      "properties": {
        "logs": {
          "type": "number"
        },
        "artifacts": {
          "type": "number"
        },
        "audit": {
          "type": "number"
        }
      },
      "required": [
        "logs",
        "artifacts",
        "audit"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "orgId",
    "allowedProviders",
    "requirePrApproval",
    "protectedPaths",
    "networkAllowlist",
    "requiredChecks",
    "maxFixRetries",
    "sessionTimeoutMin",
    "approvalRules",
    "suppressionMaxDays",
    "retentionDays"
  ],
  "additionalProperties": false
}
```

### PolicyCheck

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PolicyCheck",
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    },
    "required": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "passed",
        "failed",
        "pending",
        "missing"
      ]
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "name",
    "required",
    "status",
    "detail"
  ],
  "additionalProperties": false
}
```

### PolicyPatch

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PolicyPatch",
  "type": "object",
  "properties": {
    "allowedProviders": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Provider"
      }
    },
    "requirePrApproval": {
      "type": "boolean"
    },
    "protectedPaths": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "networkAllowlist": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "requiredChecks": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "maxFixRetries": {
      "type": "integer",
      "minimum": 0,
      "maximum": 10
    },
    "sessionTimeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "approvalRules": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ApprovalRule"
      }
    },
    "suppressionMaxDays": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "retentionDays": {
      "type": "object",
      "properties": {
        "logs": {
          "type": "number"
        },
        "artifacts": {
          "type": "number"
        },
        "audit": {
          "type": "number"
        }
      },
      "required": [
        "logs",
        "artifacts",
        "audit"
      ],
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

### Priority

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Priority",
  "type": "string",
  "enum": [
    "urgent",
    "high",
    "medium",
    "low"
  ]
}
```

### Project

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Project",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "client": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "orgId",
    "name",
    "description",
    "color",
    "createdAt"
  ],
  "additionalProperties": false
}
```

### ProjectDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ProjectDetail",
  "type": "object",
  "properties": {
    "project": {
      "$ref": "#/schemas/ProjectSummary"
    },
    "repositories": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/RepositorySummary"
      }
    },
    "tasks": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TaskListItem"
      }
    },
    "pullRequests": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/PullRequestListItem"
      }
    },
    "runs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestRunListItem"
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/FindingListItem"
      }
    }
  },
  "required": [
    "project",
    "repositories",
    "tasks",
    "pullRequests",
    "runs",
    "findings"
  ],
  "additionalProperties": false
}
```

### ProjectSummary

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ProjectSummary",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "client": {
      "type": "string"
    },
    "repositories": {
      "type": "number"
    },
    "healthScore": {
      "type": [
        "number",
        "null"
      ]
    },
    "openPrs": {
      "type": "number"
    },
    "failingChecks": {
      "type": "number"
    },
    "activeSessions": {
      "type": "number"
    },
    "openFindings": {
      "type": "number"
    },
    "verifiedThisMonth": {
      "type": "number"
    }
  },
  "required": [
    "id",
    "orgId",
    "name",
    "description",
    "color",
    "createdAt",
    "repositories",
    "healthScore",
    "openPrs",
    "failingChecks",
    "activeSessions",
    "openFindings",
    "verifiedThisMonth"
  ],
  "additionalProperties": false
}
```

### Provider

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Provider",
  "type": "string",
  "enum": [
    "claude_code",
    "openai_codex",
    "devin",
    "cursor"
  ]
}
```

### PullRequest

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PullRequest",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "number": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "title": {
      "type": "string"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "author": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "person",
            "agent"
          ]
        },
        "id": {
          "type": "string"
        },
        "sessionId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "type",
        "id",
        "sessionId"
      ],
      "additionalProperties": false
    },
    "openedBy": {
      "type": "string"
    },
    "branch": {
      "type": "string"
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "headSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "merged",
        "closed"
      ]
    },
    "openedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "mergedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "mergedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "aiAuthoredPct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
    },
    "additions": {
      "type": "number"
    },
    "deletions": {
      "type": "number"
    },
    "changedFiles": {
      "type": "number"
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "checkStatus": {
      "$ref": "#/schemas/TestRunStatus"
    },
    "reviewers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "reviewState": {
      "type": "string",
      "enum": [
        "review_requested",
        "approved",
        "changes_requested"
      ]
    },
    "latestRunId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "number",
    "title",
    "url",
    "author",
    "openedBy",
    "branch",
    "baseSha",
    "headSha",
    "status",
    "openedAt",
    "mergedAt",
    "mergedBy",
    "aiAuthoredPct",
    "additions",
    "deletions",
    "changedFiles",
    "taskId",
    "checkStatus",
    "reviewers",
    "reviewState",
    "latestRunId"
  ],
  "additionalProperties": false
}
```

### PullRequestDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PullRequestDetail",
  "type": "object",
  "properties": {
    "pullRequest": {
      "$ref": "#/schemas/PullRequestListItem"
    },
    "repository": {
      "$ref": "#/schemas/Repository"
    },
    "task": {
      "anyOf": [
        {
          "$ref": "#/schemas/Task"
        },
        {
          "type": "null"
        }
      ]
    },
    "session": {
      "anyOf": [
        {
          "$ref": "#/schemas/Session"
        },
        {
          "type": "null"
        }
      ]
    },
    "runs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestRunListItem"
      }
    },
    "latestResults": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "runId": {
            "type": "string"
          },
          "suiteId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "outcome": {
            "$ref": "#/schemas/TestOutcome"
          },
          "classification": {
            "anyOf": [
              {
                "$ref": "#/schemas/FailureClass"
              },
              {
                "type": "null"
              }
            ]
          },
          "durationMs": {
            "type": "number"
          },
          "retries": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "error": {
            "type": [
              "string",
              "null"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "$ref": "#/schemas/EvidenceRef"
            }
          },
          "firstFailedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
              },
              {
                "type": "null"
              }
            ]
          },
          "suiteName": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "runId",
          "suiteId",
          "name",
          "outcome",
          "classification",
          "durationMs",
          "retries",
          "error",
          "evidence",
          "firstFailedAt",
          "suiteName"
        ],
        "additionalProperties": false
      }
    },
    "bugs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Bug"
      }
    },
    "releasePolicy": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/PolicyCheck"
      }
    },
    "mergeable": {
      "type": "boolean"
    },
    "mergeBlockers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "pullRequest",
    "repository",
    "task",
    "session",
    "runs",
    "latestResults",
    "bugs",
    "releasePolicy",
    "mergeable",
    "mergeBlockers"
  ],
  "additionalProperties": false
}
```

### PullRequestListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/PullRequestListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "number": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "title": {
      "type": "string"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "author": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "person",
            "agent"
          ]
        },
        "id": {
          "type": "string"
        },
        "sessionId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "type",
        "id",
        "sessionId"
      ],
      "additionalProperties": false
    },
    "openedBy": {
      "type": "string"
    },
    "branch": {
      "type": "string"
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "headSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "merged",
        "closed"
      ]
    },
    "openedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "mergedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "mergedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "aiAuthoredPct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
    },
    "additions": {
      "type": "number"
    },
    "deletions": {
      "type": "number"
    },
    "changedFiles": {
      "type": "number"
    },
    "taskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "checkStatus": {
      "$ref": "#/schemas/TestRunStatus"
    },
    "reviewers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "reviewState": {
      "type": "string",
      "enum": [
        "review_requested",
        "approved",
        "changes_requested"
      ]
    },
    "latestRunId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "authorResolved": {
      "$ref": "#/schemas/ResolvedActor"
    },
    "taskTitle": {
      "type": [
        "string",
        "null"
      ]
    },
    "latestRun": {
      "anyOf": [
        {
          "$ref": "#/schemas/TestRun"
        },
        {
          "type": "null"
        }
      ]
    },
    "openBugs": {
      "type": "number"
    },
    "requiredChecksMet": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "number",
    "title",
    "url",
    "author",
    "openedBy",
    "branch",
    "baseSha",
    "headSha",
    "status",
    "openedAt",
    "mergedAt",
    "mergedBy",
    "aiAuthoredPct",
    "additions",
    "deletions",
    "changedFiles",
    "taskId",
    "checkStatus",
    "reviewers",
    "reviewState",
    "latestRunId",
    "repositoryName",
    "authorResolved",
    "taskTitle",
    "latestRun",
    "openBugs",
    "requiredChecksMet"
  ],
  "additionalProperties": false
}
```

### RepoConfigInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/RepoConfigInput",
  "type": "object",
  "properties": {
    "testCommands": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "scanSchedule": {
      "type": "string",
      "enum": [
        "daily",
        "weekly",
        "on_push",
        "off"
      ]
    }
  },
  "required": [
    "testCommands",
    "scanSchedule"
  ],
  "additionalProperties": false
}
```

### Repository

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Repository",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "provider": {
      "type": "string",
      "const": "github"
    },
    "fullName": {
      "type": "string"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "defaultBranch": {
      "type": "string"
    },
    "private": {
      "type": "boolean"
    },
    "languages": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "frameworks": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ecosystems": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "npm",
          "pypi"
        ]
      }
    },
    "testCommands": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ciWorkflows": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "indexedSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "indexedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "indexStatus": {
      "type": "string",
      "enum": [
        "pending",
        "indexing",
        "ready",
        "error"
      ]
    },
    "indexReadyAt": {
      "type": "number"
    },
    "fileCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "hasDocs": {
      "type": "boolean"
    },
    "scanSchedule": {
      "type": "string",
      "enum": [
        "daily",
        "weekly",
        "on_push",
        "off"
      ]
    },
    "health": {
      "$ref": "#/schemas/Health"
    }
  },
  "required": [
    "id",
    "projectId",
    "orgId",
    "provider",
    "fullName",
    "url",
    "defaultBranch",
    "private",
    "languages",
    "frameworks",
    "ecosystems",
    "testCommands",
    "ciWorkflows",
    "indexedSha",
    "indexedAt",
    "indexStatus",
    "fileCount",
    "hasDocs",
    "scanSchedule",
    "health"
  ],
  "additionalProperties": false
}
```

### RepositoryDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/RepositoryDetail",
  "type": "object",
  "properties": {
    "repository": {
      "$ref": "#/schemas/RepositorySummary"
    },
    "suites": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestSuite"
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Finding"
      }
    },
    "dependencies": {
      "type": "number"
    },
    "history": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/HealthSnapshot"
      }
    },
    "scans": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Scan"
      }
    },
    "runs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestRunListItem"
      }
    },
    "pullRequests": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/PullRequestListItem"
      }
    }
  },
  "required": [
    "repository",
    "suites",
    "findings",
    "dependencies",
    "history",
    "scans",
    "runs",
    "pullRequests"
  ],
  "additionalProperties": false
}
```

### RepositorySummary

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/RepositorySummary",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "provider": {
      "type": "string",
      "const": "github"
    },
    "fullName": {
      "type": "string"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "defaultBranch": {
      "type": "string"
    },
    "private": {
      "type": "boolean"
    },
    "languages": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "frameworks": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ecosystems": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "npm",
          "pypi"
        ]
      }
    },
    "testCommands": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "ciWorkflows": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "indexedSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "indexedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "indexStatus": {
      "type": "string",
      "enum": [
        "pending",
        "indexing",
        "ready",
        "error"
      ]
    },
    "indexReadyAt": {
      "type": "number"
    },
    "fileCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "hasDocs": {
      "type": "boolean"
    },
    "scanSchedule": {
      "type": "string",
      "enum": [
        "daily",
        "weekly",
        "on_push",
        "off"
      ]
    },
    "health": {
      "$ref": "#/schemas/Health"
    },
    "projectName": {
      "type": "string"
    },
    "openFindings": {
      "type": "number"
    },
    "criticalFindings": {
      "type": "number"
    },
    "suites": {
      "type": "number"
    },
    "lastRunStatus": {
      "type": [
        "string",
        "null"
      ]
    },
    "lastRunAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "openPrs": {
      "type": "number"
    },
    "healthDelta": {
      "type": "number"
    },
    "scanRunning": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "projectId",
    "orgId",
    "provider",
    "fullName",
    "url",
    "defaultBranch",
    "private",
    "languages",
    "frameworks",
    "ecosystems",
    "testCommands",
    "ciWorkflows",
    "indexedSha",
    "indexedAt",
    "indexStatus",
    "fileCount",
    "hasDocs",
    "scanSchedule",
    "health",
    "projectName",
    "openFindings",
    "criticalFindings",
    "suites",
    "lastRunStatus",
    "lastRunAt",
    "openPrs",
    "healthDelta",
    "scanRunning"
  ],
  "additionalProperties": false
}
```

### ResolvedActor

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ResolvedActor",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "person",
        "agent",
        "system"
      ]
    },
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "id",
    "name",
    "detail"
  ],
  "additionalProperties": false
}
```

### ReviewInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ReviewInput",
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "approved",
        "changes_requested"
      ]
    },
    "comment": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "decision",
    "comment"
  ],
  "additionalProperties": false
}
```

### Role

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Role",
  "type": "string",
  "enum": [
    "owner",
    "admin",
    "member",
    "viewer"
  ]
}
```

### RoleChangeInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/RoleChangeInput",
  "type": "object",
  "properties": {
    "role": {
      "$ref": "#/schemas/Role"
    }
  },
  "required": [
    "role"
  ],
  "additionalProperties": false
}
```

### Scan

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Scan",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "commitSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "completed",
        "failed"
      ]
    },
    "trigger": {
      "type": "string",
      "enum": [
        "schedule",
        "push",
        "manual",
        "onboarding"
      ]
    },
    "startedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "finishedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "findingsCount": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "scoreAfter": {
      "type": [
        "number",
        "null"
      ]
    },
    "scoreDelta": {
      "type": [
        "number",
        "null"
      ]
    },
    "changes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "config": {
      "type": "object",
      "properties": {
        "ecosystems": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "checks": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "ecosystems",
        "checks"
      ],
      "additionalProperties": false
    },
    "simulatedEndsAt": {
      "type": "number"
    }
  },
  "required": [
    "id",
    "repositoryId",
    "orgId",
    "commitSha",
    "status",
    "trigger",
    "startedAt",
    "finishedAt",
    "findingsCount",
    "scoreAfter",
    "scoreDelta",
    "changes",
    "config"
  ],
  "additionalProperties": false
}
```

### SearchResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SearchResult",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "project",
        "repository",
        "task",
        "pull_request",
        "bug",
        "finding",
        "session"
      ]
    },
    "id": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "subtitle": {
      "type": "string"
    },
    "href": {
      "type": "string"
    }
  },
  "required": [
    "kind",
    "id",
    "title",
    "subtitle",
    "href"
  ],
  "additionalProperties": false
}
```

### Session

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Session",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "taskId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "attempt": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "status": {
      "$ref": "#/schemas/SessionStatus"
    },
    "startedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "endedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "tokensIn": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "tokensOut": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "costUsd": {
      "type": "number"
    },
    "summary": {
      "type": [
        "string",
        "null"
      ]
    },
    "changedFiles": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ChangedFile"
      }
    },
    "headSha": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{7,40}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "waitingFor": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "approval",
                "clarification"
              ]
            },
            "approvalId": {
              "type": "string"
            },
            "question": {
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "notes": {
      "type": [
        "string",
        "null"
      ]
    },
    "logSeed": {
      "type": "number"
    },
    "simulated": {
      "type": "boolean"
    },
    "simulatedEndsAt": {
      "type": "number"
    },
    "simulateFailure": {
      "type": "boolean"
    },
    "approvalCheckpointAt": {
      "type": "number"
    },
    "pausedRemainingMs": {
      "type": "number"
    }
  },
  "required": [
    "id",
    "taskId",
    "orgId",
    "agentId",
    "attempt",
    "status",
    "startedAt",
    "endedAt",
    "tokensIn",
    "tokensOut",
    "costUsd",
    "summary",
    "changedFiles",
    "headSha",
    "waitingFor",
    "notes",
    "logSeed",
    "simulated"
  ],
  "additionalProperties": false
}
```

### SessionDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SessionDetail",
  "type": "object",
  "properties": {
    "session": {
      "$ref": "#/schemas/SessionListItem"
    },
    "task": {
      "$ref": "#/schemas/Task"
    },
    "workspace": {
      "anyOf": [
        {
          "$ref": "#/schemas/Workspace"
        },
        {
          "type": "null"
        }
      ]
    },
    "approvals": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Approval"
      }
    },
    "otherAttempts": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Session"
      }
    }
  },
  "required": [
    "session",
    "task",
    "workspace",
    "approvals",
    "otherAttempts"
  ],
  "additionalProperties": false
}
```

### SessionInfo

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SessionInfo",
  "type": "object",
  "properties": {
    "user": {
      "$ref": "#/schemas/User"
    },
    "workspace": {
      "$ref": "#/schemas/Organization"
    },
    "role": {
      "$ref": "#/schemas/Role"
    },
    "workspaces": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/WorkspaceMembership"
      }
    },
    "personas": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "email": {
            "type": "string",
            "format": "email",
            "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
          },
          "title": {
            "default": "",
            "type": "string"
          },
          "githubLogin": {
            "type": "string"
          },
          "workspaces": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "orgId": {
                  "type": "string"
                },
                "name": {
                  "type": "string"
                },
                "role": {
                  "$ref": "#/schemas/Role"
                }
              },
              "required": [
                "orgId",
                "name",
                "role"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "id",
          "name",
          "email",
          "title",
          "workspaces"
        ],
        "additionalProperties": false
      }
    },
    "counts": {
      "type": "object",
      "properties": {
        "pendingApprovals": {
          "type": "number"
        },
        "reviewReady": {
          "type": "number"
        },
        "unreadNotifications": {
          "type": "number"
        },
        "pendingVisuals": {
          "type": "number"
        }
      },
      "required": [
        "pendingApprovals",
        "reviewReady",
        "unreadNotifications",
        "pendingVisuals"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "user",
    "workspace",
    "role",
    "workspaces",
    "personas",
    "counts"
  ],
  "additionalProperties": false
}
```

### SessionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SessionInput",
  "type": "object",
  "properties": {
    "answer": {
      "type": "string",
      "minLength": 2
    }
  },
  "required": [
    "answer"
  ],
  "additionalProperties": false
}
```

### SessionListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SessionListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "taskId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "attempt": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "status": {
      "$ref": "#/schemas/SessionStatus"
    },
    "startedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "endedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "tokensIn": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "tokensOut": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "costUsd": {
      "type": "number"
    },
    "summary": {
      "type": [
        "string",
        "null"
      ]
    },
    "changedFiles": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ChangedFile"
      }
    },
    "headSha": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{7,40}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "waitingFor": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "approval",
                "clarification"
              ]
            },
            "approvalId": {
              "type": "string"
            },
            "question": {
              "type": "string"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "notes": {
      "type": [
        "string",
        "null"
      ]
    },
    "logSeed": {
      "type": "number"
    },
    "simulated": {
      "type": "boolean"
    },
    "simulatedEndsAt": {
      "type": "number"
    },
    "simulateFailure": {
      "type": "boolean"
    },
    "approvalCheckpointAt": {
      "type": "number"
    },
    "pausedRemainingMs": {
      "type": "number"
    },
    "taskTitle": {
      "type": "string"
    },
    "repositoryName": {
      "type": "string"
    },
    "agent": {
      "$ref": "#/schemas/Agent"
    },
    "durationSec": {
      "type": [
        "number",
        "null"
      ]
    },
    "workspaceState": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "taskId",
    "orgId",
    "agentId",
    "attempt",
    "status",
    "startedAt",
    "endedAt",
    "tokensIn",
    "tokensOut",
    "costUsd",
    "summary",
    "changedFiles",
    "headSha",
    "waitingFor",
    "notes",
    "logSeed",
    "simulated",
    "taskTitle",
    "repositoryName",
    "agent",
    "durationSec",
    "workspaceState"
  ],
  "additionalProperties": false
}
```

### SessionStatus

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SessionStatus",
  "type": "string",
  "enum": [
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled"
  ]
}
```

### Severity

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Severity",
  "type": "string",
  "enum": [
    "critical",
    "high",
    "medium",
    "low"
  ]
}
```

### ShipSafeOverview

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/ShipSafeOverview",
  "type": "object",
  "properties": {
    "passRateTrend": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string"
          },
          "passRatePct": {
            "type": "number"
          },
          "runs": {
            "type": "number"
          }
        },
        "required": [
          "date",
          "passRatePct",
          "runs"
        ],
        "additionalProperties": false
      }
    },
    "kpis": {
      "type": "object",
      "properties": {
        "runs7d": {
          "type": "number"
        },
        "passRatePct": {
          "type": "number"
        },
        "medianDurationSec": {
          "type": "number"
        },
        "flakyRatePct": {
          "type": "number"
        },
        "openBugs": {
          "type": "number"
        },
        "verificationCoveragePct": {
          "type": "number"
        },
        "actionableDefectPct": {
          "type": "number"
        }
      },
      "required": [
        "runs7d",
        "passRatePct",
        "medianDurationSec",
        "flakyRatePct",
        "openBugs",
        "verificationCoveragePct",
        "actionableDefectPct"
      ],
      "additionalProperties": false
    },
    "failureBreakdown": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "classification": {
            "$ref": "#/schemas/FailureClass"
          },
          "count": {
            "type": "number"
          }
        },
        "required": [
          "classification",
          "count"
        ],
        "additionalProperties": false
      }
    },
    "repositories": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "repositoryId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "passRatePct": {
            "type": "number"
          },
          "runs": {
            "type": "number"
          },
          "lastStatus": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "repositoryId",
          "name",
          "passRatePct",
          "runs",
          "lastStatus"
        ],
        "additionalProperties": false
      }
    },
    "recentRuns": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestRunListItem"
      }
    },
    "openBugs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/BugListItem"
      }
    }
  },
  "required": [
    "passRateTrend",
    "kpis",
    "failureBreakdown",
    "repositories",
    "recentRuns",
    "openBugs"
  ],
  "additionalProperties": false
}
```

### SignInInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SignInInput",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    }
  },
  "required": [
    "userId"
  ],
  "additionalProperties": false
}
```

### SignUpInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SignUpInput",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 2
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "method": {
      "type": "string",
      "enum": [
        "github",
        "email"
      ]
    },
    "password": {
      "type": "string",
      "minLength": 10,
      "maxLength": 200
    },
    "invitationToken": {
      "type": "string"
    }
  },
  "required": [
    "name",
    "email",
    "method"
  ],
  "additionalProperties": false
}
```

### SwitchWorkspaceInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/SwitchWorkspaceInput",
  "type": "object",
  "properties": {
    "orgId": {
      "type": "string"
    }
  },
  "required": [
    "orgId"
  ],
  "additionalProperties": false
}
```

### Task

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Task",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "acceptanceCriteria": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "constraints": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "priority": {
      "$ref": "#/schemas/Priority"
    },
    "status": {
      "$ref": "#/schemas/TaskStatus"
    },
    "source": {
      "$ref": "#/schemas/TaskSource"
    },
    "sourceRef": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "agentId": {
      "type": [
        "string",
        "null"
      ]
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "targetBranch": {
      "type": "string"
    },
    "branch": {
      "type": "string"
    },
    "budgetUsd": {
      "type": "number",
      "minimum": 0
    },
    "timeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "parentTaskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "bugId": {
      "type": [
        "string",
        "null"
      ]
    },
    "findingId": {
      "type": [
        "string",
        "null"
      ]
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "assigneeId": {
      "type": [
        "string",
        "null"
      ]
    },
    "clarityWarning": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "projectId",
    "repositoryId",
    "title",
    "description",
    "acceptanceCriteria",
    "constraints",
    "priority",
    "status",
    "source",
    "sourceRef",
    "createdBy",
    "createdAt",
    "agentId",
    "baseSha",
    "targetBranch",
    "branch",
    "budgetUsd",
    "timeoutMin",
    "parentTaskId",
    "bugId",
    "findingId",
    "pullRequestId",
    "assigneeId",
    "clarityWarning"
  ],
  "additionalProperties": false
}
```

### TaskAction

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskAction",
  "type": "string",
  "enum": [
    "launch",
    "cancel",
    "retry",
    "create_pr",
    "mark_ready",
    "archive"
  ]
}
```

### TaskActionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskActionInput",
  "type": "object",
  "properties": {
    "action": {
      "$ref": "#/schemas/TaskAction"
    },
    "notes": {
      "type": "string"
    },
    "simulateFailure": {
      "type": "boolean"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

### TaskDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskDetail",
  "type": "object",
  "properties": {
    "task": {
      "$ref": "#/schemas/TaskListItem"
    },
    "sessions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "taskId": {
            "type": "string"
          },
          "orgId": {
            "type": "string"
          },
          "agentId": {
            "type": "string"
          },
          "attempt": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "status": {
            "$ref": "#/schemas/SessionStatus"
          },
          "startedAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          "endedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
              },
              {
                "type": "null"
              }
            ]
          },
          "tokensIn": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "tokensOut": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "costUsd": {
            "type": "number"
          },
          "summary": {
            "type": [
              "string",
              "null"
            ]
          },
          "changedFiles": {
            "type": "array",
            "items": {
              "$ref": "#/schemas/ChangedFile"
            }
          },
          "headSha": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[0-9a-f]{7,40}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "waitingFor": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "approval",
                      "clarification"
                    ]
                  },
                  "approvalId": {
                    "type": "string"
                  },
                  "question": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "notes": {
            "type": [
              "string",
              "null"
            ]
          },
          "logSeed": {
            "type": "number"
          },
          "simulated": {
            "type": "boolean"
          },
          "simulatedEndsAt": {
            "type": "number"
          },
          "simulateFailure": {
            "type": "boolean"
          },
          "approvalCheckpointAt": {
            "type": "number"
          },
          "pausedRemainingMs": {
            "type": "number"
          },
          "workspace": {
            "anyOf": [
              {
                "$ref": "#/schemas/Workspace"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "taskId",
          "orgId",
          "agentId",
          "attempt",
          "status",
          "startedAt",
          "endedAt",
          "tokensIn",
          "tokensOut",
          "costUsd",
          "summary",
          "changedFiles",
          "headSha",
          "waitingFor",
          "notes",
          "logSeed",
          "simulated",
          "workspace"
        ],
        "additionalProperties": false
      }
    },
    "approvals": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Approval"
      }
    },
    "pullRequest": {
      "anyOf": [
        {
          "$ref": "#/schemas/PullRequestListItem"
        },
        {
          "type": "null"
        }
      ]
    },
    "runs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/TestRunListItem"
      }
    },
    "bug": {
      "anyOf": [
        {
          "$ref": "#/schemas/Bug"
        },
        {
          "type": "null"
        }
      ]
    },
    "finding": {
      "anyOf": [
        {
          "$ref": "#/schemas/Finding"
        },
        {
          "type": "null"
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "$ref": "#/schemas/Task"
        },
        {
          "type": "null"
        }
      ]
    },
    "children": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Task"
      }
    },
    "lifecycle": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/LifecycleStep"
      }
    },
    "activity": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/ActivityItem"
      }
    },
    "policyPreview": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "requiresApproval": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "prohibited": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "budgetRemainingUsd": {
          "type": "number"
        }
      },
      "required": [
        "allowed",
        "requiresApproval",
        "prohibited",
        "budgetRemainingUsd"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "task",
    "sessions",
    "approvals",
    "pullRequest",
    "runs",
    "bug",
    "finding",
    "parent",
    "children",
    "lifecycle",
    "activity",
    "policyPreview"
  ],
  "additionalProperties": false
}
```

### TaskListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "acceptanceCriteria": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "constraints": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "priority": {
      "$ref": "#/schemas/Priority"
    },
    "status": {
      "$ref": "#/schemas/TaskStatus"
    },
    "source": {
      "$ref": "#/schemas/TaskSource"
    },
    "sourceRef": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "agentId": {
      "type": [
        "string",
        "null"
      ]
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "targetBranch": {
      "type": "string"
    },
    "branch": {
      "type": "string"
    },
    "budgetUsd": {
      "type": "number",
      "minimum": 0
    },
    "timeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "parentTaskId": {
      "type": [
        "string",
        "null"
      ]
    },
    "bugId": {
      "type": [
        "string",
        "null"
      ]
    },
    "findingId": {
      "type": [
        "string",
        "null"
      ]
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "assigneeId": {
      "type": [
        "string",
        "null"
      ]
    },
    "clarityWarning": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "projectName": {
      "type": "string"
    },
    "agent": {
      "anyOf": [
        {
          "$ref": "#/schemas/Agent"
        },
        {
          "type": "null"
        }
      ]
    },
    "createdByUser": {
      "anyOf": [
        {
          "$ref": "#/schemas/User"
        },
        {
          "type": "null"
        }
      ]
    },
    "latestSession": {
      "anyOf": [
        {
          "$ref": "#/schemas/Session"
        },
        {
          "type": "null"
        }
      ]
    },
    "attempts": {
      "type": "number"
    },
    "pullRequest": {
      "anyOf": [
        {
          "$ref": "#/schemas/PullRequest"
        },
        {
          "type": "null"
        }
      ]
    },
    "latestRunStatus": {
      "type": [
        "string",
        "null"
      ]
    },
    "costUsd": {
      "type": "number"
    },
    "verified": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "orgId",
    "projectId",
    "repositoryId",
    "title",
    "description",
    "acceptanceCriteria",
    "constraints",
    "priority",
    "status",
    "source",
    "sourceRef",
    "createdBy",
    "createdAt",
    "agentId",
    "baseSha",
    "targetBranch",
    "branch",
    "budgetUsd",
    "timeoutMin",
    "parentTaskId",
    "bugId",
    "findingId",
    "pullRequestId",
    "assigneeId",
    "clarityWarning",
    "repositoryName",
    "projectName",
    "agent",
    "createdByUser",
    "latestSession",
    "attempts",
    "pullRequest",
    "latestRunStatus",
    "costUsd",
    "verified"
  ],
  "additionalProperties": false
}
```

### TaskSource

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskSource",
  "type": "string",
  "enum": [
    "manual",
    "github_issue",
    "linear",
    "jira",
    "shipsafe_failure",
    "codekeeper_finding"
  ]
}
```

### TaskStatus

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TaskStatus",
  "type": "string",
  "enum": [
    "draft",
    "queued",
    "running",
    "waiting_input",
    "verifying",
    "review_ready",
    "completed",
    "failed",
    "cancelled"
  ]
}
```

### TestOutcome

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestOutcome",
  "type": "string",
  "enum": [
    "passed",
    "failed",
    "flaky",
    "skipped"
  ]
}
```

### TestResult

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestResult",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "runId": {
      "type": "string"
    },
    "suiteId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "outcome": {
      "$ref": "#/schemas/TestOutcome"
    },
    "classification": {
      "anyOf": [
        {
          "$ref": "#/schemas/FailureClass"
        },
        {
          "type": "null"
        }
      ]
    },
    "durationMs": {
      "type": "number"
    },
    "retries": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "error": {
      "type": [
        "string",
        "null"
      ]
    },
    "evidence": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/EvidenceRef"
      }
    },
    "firstFailedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "runId",
    "suiteId",
    "name",
    "outcome",
    "classification",
    "durationMs",
    "retries",
    "error",
    "evidence",
    "firstFailedAt"
  ],
  "additionalProperties": false
}
```

### TestRun

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestRun",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "trigger": {
      "type": "string"
    },
    "headSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "branch": {
      "type": "string"
    },
    "environment": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "url": {
          "type": [
            "string",
            "null"
          ]
        },
        "node": {
          "type": [
            "string",
            "null"
          ]
        },
        "python": {
          "type": [
            "string",
            "null"
          ]
        },
        "worker": {
          "type": "string"
        },
        "region": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "url",
        "node",
        "python",
        "worker",
        "region"
      ],
      "additionalProperties": false
    },
    "status": {
      "$ref": "#/schemas/TestRunStatus"
    },
    "startedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "finishedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "durationSec": {
      "type": [
        "number",
        "null"
      ]
    },
    "selectedSuites": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "suiteId": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "suiteId",
          "reason"
        ],
        "additionalProperties": false
      }
    },
    "retestOf": {
      "type": [
        "string",
        "null"
      ]
    },
    "checkRun": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "conclusion": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "success",
                    "failure",
                    "neutral"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "detailsUrl": {
              "type": "string"
            }
          },
          "required": [
            "name",
            "conclusion",
            "detailsUrl"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "totals": {
      "type": "object",
      "properties": {
        "passed": {
          "type": "number"
        },
        "failed": {
          "type": "number"
        },
        "flaky": {
          "type": "number"
        },
        "skipped": {
          "type": "number"
        }
      },
      "required": [
        "passed",
        "failed",
        "flaky",
        "skipped"
      ],
      "additionalProperties": false
    },
    "billedBrowserMinutes": {
      "type": "number"
    },
    "infraError": {
      "type": "string"
    },
    "simulatedEndsAt": {
      "type": "number"
    },
    "simulateFailure": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "pullRequestId",
    "trigger",
    "headSha",
    "baseSha",
    "branch",
    "environment",
    "status",
    "startedAt",
    "finishedAt",
    "durationSec",
    "selectedSuites",
    "retestOf",
    "checkRun",
    "totals",
    "billedBrowserMinutes"
  ],
  "additionalProperties": false
}
```

### TestRunDetail

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestRunDetail",
  "type": "object",
  "properties": {
    "run": {
      "$ref": "#/schemas/TestRunListItem"
    },
    "repository": {
      "$ref": "#/schemas/Repository"
    },
    "pullRequest": {
      "anyOf": [
        {
          "$ref": "#/schemas/PullRequest"
        },
        {
          "type": "null"
        }
      ]
    },
    "suites": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "repositoryId": {
            "type": "string"
          },
          "orgId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "type": {
            "type": "string",
            "enum": [
              "unit",
              "playwright",
              "api"
            ]
          },
          "command": {
            "type": "string"
          },
          "environment": {
            "type": "string"
          },
          "pathRules": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "timeoutMin": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "owner": {
            "type": "string"
          },
          "enabled": {
            "type": "boolean"
          },
          "required": {
            "type": "boolean"
          },
          "flakyRatePct": {
            "type": "number",
            "minimum": 0
          },
          "testCount": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "reason": {
            "type": "string"
          },
          "passed": {
            "type": "number"
          },
          "failed": {
            "type": "number"
          },
          "flaky": {
            "type": "number"
          }
        },
        "required": [
          "id",
          "repositoryId",
          "orgId",
          "name",
          "type",
          "command",
          "environment",
          "pathRules",
          "timeoutMin",
          "owner",
          "enabled",
          "required",
          "flakyRatePct",
          "testCount",
          "reason",
          "passed",
          "failed",
          "flaky"
        ],
        "additionalProperties": false
      }
    },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "runId": {
            "type": "string"
          },
          "suiteId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "outcome": {
            "$ref": "#/schemas/TestOutcome"
          },
          "classification": {
            "anyOf": [
              {
                "$ref": "#/schemas/FailureClass"
              },
              {
                "type": "null"
              }
            ]
          },
          "durationMs": {
            "type": "number"
          },
          "retries": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "error": {
            "type": [
              "string",
              "null"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "$ref": "#/schemas/EvidenceRef"
            }
          },
          "firstFailedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
              },
              {
                "type": "null"
              }
            ]
          },
          "suiteName": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "runId",
          "suiteId",
          "name",
          "outcome",
          "classification",
          "durationMs",
          "retries",
          "error",
          "evidence",
          "firstFailedAt",
          "suiteName"
        ],
        "additionalProperties": false
      }
    },
    "previous": {
      "anyOf": [
        {
          "$ref": "#/schemas/TestRun"
        },
        {
          "type": "null"
        }
      ]
    },
    "comparison": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "newlyFailing": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "fixed": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "stillFailing": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "newlyFailing",
            "fixed",
            "stillFailing"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "bugs": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/Bug"
      }
    },
    "workerLog": {
      "type": "array",
      "items": {
        "$ref": "#/schemas/LogLine"
      }
    }
  },
  "required": [
    "run",
    "repository",
    "pullRequest",
    "suites",
    "results",
    "previous",
    "comparison",
    "bugs",
    "workerLog"
  ],
  "additionalProperties": false
}
```

### TestRunListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestRunListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "trigger": {
      "type": "string"
    },
    "headSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "branch": {
      "type": "string"
    },
    "environment": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "url": {
          "type": [
            "string",
            "null"
          ]
        },
        "node": {
          "type": [
            "string",
            "null"
          ]
        },
        "python": {
          "type": [
            "string",
            "null"
          ]
        },
        "worker": {
          "type": "string"
        },
        "region": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "url",
        "node",
        "python",
        "worker",
        "region"
      ],
      "additionalProperties": false
    },
    "status": {
      "$ref": "#/schemas/TestRunStatus"
    },
    "startedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "finishedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "durationSec": {
      "type": [
        "number",
        "null"
      ]
    },
    "selectedSuites": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "suiteId": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "suiteId",
          "reason"
        ],
        "additionalProperties": false
      }
    },
    "retestOf": {
      "type": [
        "string",
        "null"
      ]
    },
    "checkRun": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "name": {
              "type": "string"
            },
            "conclusion": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "success",
                    "failure",
                    "neutral"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "detailsUrl": {
              "type": "string"
            }
          },
          "required": [
            "name",
            "conclusion",
            "detailsUrl"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "totals": {
      "type": "object",
      "properties": {
        "passed": {
          "type": "number"
        },
        "failed": {
          "type": "number"
        },
        "flaky": {
          "type": "number"
        },
        "skipped": {
          "type": "number"
        }
      },
      "required": [
        "passed",
        "failed",
        "flaky",
        "skipped"
      ],
      "additionalProperties": false
    },
    "billedBrowserMinutes": {
      "type": "number"
    },
    "infraError": {
      "type": "string"
    },
    "simulatedEndsAt": {
      "type": "number"
    },
    "simulateFailure": {
      "type": "boolean"
    },
    "repositoryName": {
      "type": "string"
    },
    "pullRequestNumber": {
      "type": [
        "number",
        "null"
      ]
    },
    "pullRequestTitle": {
      "type": [
        "string",
        "null"
      ]
    },
    "failureClasses": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "number"
      }
    }
  },
  "required": [
    "id",
    "orgId",
    "repositoryId",
    "pullRequestId",
    "trigger",
    "headSha",
    "baseSha",
    "branch",
    "environment",
    "status",
    "startedAt",
    "finishedAt",
    "durationSec",
    "selectedSuites",
    "retestOf",
    "checkRun",
    "totals",
    "billedBrowserMinutes",
    "repositoryName",
    "pullRequestNumber",
    "pullRequestTitle",
    "failureClasses"
  ],
  "additionalProperties": false
}
```

### TestRunStatus

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestRunStatus",
  "type": "string",
  "enum": [
    "queued",
    "running",
    "passed",
    "failed",
    "errored"
  ]
}
```

### TestSuite

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestSuite",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "repositoryId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "type": {
      "type": "string",
      "enum": [
        "unit",
        "playwright",
        "api"
      ]
    },
    "command": {
      "type": "string"
    },
    "environment": {
      "type": "string"
    },
    "pathRules": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "timeoutMin": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "owner": {
      "type": "string"
    },
    "enabled": {
      "type": "boolean"
    },
    "required": {
      "type": "boolean"
    },
    "flakyRatePct": {
      "type": "number",
      "minimum": 0
    },
    "testCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "repositoryId",
    "orgId",
    "name",
    "type",
    "command",
    "environment",
    "pathRules",
    "timeoutMin",
    "owner",
    "enabled",
    "required",
    "flakyRatePct",
    "testCount"
  ],
  "additionalProperties": false
}
```

### TestSuiteInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestSuiteInput",
  "type": "object",
  "properties": {
    "repositoryId": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 2
    },
    "type": {
      "type": "string",
      "enum": [
        "unit",
        "playwright",
        "api"
      ]
    },
    "command": {
      "type": "string",
      "minLength": 2
    },
    "environment": {
      "type": "string",
      "minLength": 1
    },
    "pathRules": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "timeoutMin": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120
    },
    "required": {
      "type": "boolean"
    }
  },
  "required": [
    "repositoryId",
    "name",
    "type",
    "command",
    "environment",
    "pathRules",
    "timeoutMin",
    "required"
  ],
  "additionalProperties": false
}
```

### TestSuitePatch

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TestSuitePatch",
  "type": "object",
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "required": {
      "type": "boolean"
    },
    "command": {
      "type": "string",
      "minLength": 2
    },
    "timeoutMin": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120
    }
  },
  "additionalProperties": false
}
```

### TrendPoint

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/TrendPoint",
  "type": "object",
  "properties": {
    "date": {
      "type": "string"
    },
    "value": {
      "type": "number"
    }
  },
  "required": [
    "date",
    "value"
  ],
  "additionalProperties": false
}
```

### User

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/User",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "title": {
      "default": "",
      "type": "string"
    },
    "githubLogin": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "title"
  ],
  "additionalProperties": false
}
```

### VisualDecisionInput

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/VisualDecisionInput",
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "approved",
        "rejected"
      ]
    },
    "comment": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "decision",
    "comment"
  ],
  "additionalProperties": false
}
```

### VisualSnapshot

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/VisualSnapshot",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "runId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "route": {
      "type": "string"
    },
    "viewport": {
      "type": "string",
      "enum": [
        "desktop",
        "mobile"
      ]
    },
    "theme": {
      "type": "string",
      "enum": [
        "light",
        "dark"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "unchanged",
        "changed",
        "new",
        "approved",
        "rejected"
      ]
    },
    "diffPct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
    },
    "regions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "w": {
            "type": "number"
          },
          "h": {
            "type": "number"
          }
        },
        "required": [
          "x",
          "y",
          "w",
          "h"
        ],
        "additionalProperties": false
      }
    },
    "variant": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "baselineSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "candidateSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "decidedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "decidedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "comment": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "runId",
    "pullRequestId",
    "repositoryId",
    "name",
    "route",
    "viewport",
    "theme",
    "status",
    "diffPct",
    "regions",
    "variant",
    "baselineSha",
    "candidateSha",
    "decidedBy",
    "decidedAt",
    "comment"
  ],
  "additionalProperties": false
}
```

### VisualSnapshotListItem

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/VisualSnapshotListItem",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "runId": {
      "type": "string"
    },
    "pullRequestId": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryId": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "route": {
      "type": "string"
    },
    "viewport": {
      "type": "string",
      "enum": [
        "desktop",
        "mobile"
      ]
    },
    "theme": {
      "type": "string",
      "enum": [
        "light",
        "dark"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "unchanged",
        "changed",
        "new",
        "approved",
        "rejected"
      ]
    },
    "diffPct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
    },
    "regions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "w": {
            "type": "number"
          },
          "h": {
            "type": "number"
          }
        },
        "required": [
          "x",
          "y",
          "w",
          "h"
        ],
        "additionalProperties": false
      }
    },
    "variant": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "baselineSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "candidateSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "decidedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "decidedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "comment": {
      "type": [
        "string",
        "null"
      ]
    },
    "repositoryName": {
      "type": "string"
    },
    "pullRequestNumber": {
      "type": [
        "number",
        "null"
      ]
    },
    "pullRequestTitle": {
      "type": [
        "string",
        "null"
      ]
    },
    "decidedByUser": {
      "anyOf": [
        {
          "$ref": "#/schemas/User"
        },
        {
          "type": "null"
        }
      ]
    },
    "bugId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "orgId",
    "runId",
    "pullRequestId",
    "repositoryId",
    "name",
    "route",
    "viewport",
    "theme",
    "status",
    "diffPct",
    "regions",
    "variant",
    "baselineSha",
    "candidateSha",
    "decidedBy",
    "decidedAt",
    "comment",
    "repositoryName",
    "pullRequestNumber",
    "pullRequestTitle",
    "decidedByUser",
    "bugId"
  ],
  "additionalProperties": false
}
```

### Workspace

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/Workspace",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "orgId": {
      "type": "string"
    },
    "runtime": {
      "type": "string",
      "enum": [
        "container",
        "worktree"
      ]
    },
    "image": {
      "type": "string"
    },
    "state": {
      "type": "string",
      "enum": [
        "provisioning",
        "active",
        "cleaned"
      ]
    },
    "cpu": {
      "type": "number"
    },
    "memoryGb": {
      "type": "number"
    },
    "diskGb": {
      "type": "number"
    },
    "networkPolicy": {
      "type": "string",
      "enum": [
        "none",
        "allowlist",
        "open"
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "cleanupAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "credentials": {
      "type": "string"
    },
    "baseSha": {
      "type": "string",
      "pattern": "^[0-9a-f]{7,40}$"
    },
    "branch": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "sessionId",
    "orgId",
    "runtime",
    "image",
    "state",
    "cpu",
    "memoryGb",
    "diskGb",
    "networkPolicy",
    "createdAt",
    "cleanupAt",
    "credentials",
    "baseSha",
    "branch"
  ],
  "additionalProperties": false
}
```

### WorkspaceKind

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/WorkspaceKind",
  "type": "string",
  "enum": [
    "personal",
    "team",
    "agency"
  ]
}
```

### WorkspaceMembership

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/WorkspaceMembership",
  "type": "object",
  "properties": {
    "organization": {
      "$ref": "#/schemas/Organization"
    },
    "role": {
      "$ref": "#/schemas/Role"
    }
  },
  "required": [
    "organization",
    "role"
  ],
  "additionalProperties": false
}
```

### WorkspacePatch

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/schemas/WorkspacePatch",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 2,
      "maxLength": 48
    }
  },
  "additionalProperties": false
}
```

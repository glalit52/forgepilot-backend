/** Storage, queue, crypto and connector building blocks. */
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { compareVersions } from "../src/connectors/advisories";
import { parsePatch, parseUnifiedDiff, verifyGithubSignature } from "../src/connectors/github";
import { adfToText } from "../src/connectors/issueTrackers";
import {
  assertPublicHttpsUrl,
  isPrivateAddress,
  signWebhook,
} from "../src/connectors/outboundWebhooks";
import { claudeCode, openaiCodex, buildPrompt } from "../src/execution/agents";
import { parseJUnit } from "../src/execution/junit";
import {
  parsePackageJson,
  parsePackageLock,
  parseRequirements,
  versionFromRange,
} from "../src/execution/manifests";
import { globToRegExp, runProcess } from "../src/execution/sandbox";
import {
  hashPassword,
  hmacSha256,
  redactSecrets,
  Vault,
  verifyPassword,
} from "../src/platform/crypto";
import { enqueueJob, PermanentJobError } from "../src/platform/jobs";
import { createHarness, type Client, type Harness } from "./helpers";

let h: Harness;
let maya: Client;
const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  hooks.push({
    url: String(input),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: String(init?.body ?? ""),
  });
  return new Response("ok", { status: 200 });
};

beforeAll(async () => {
  h = await createHarness(
    {
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      STRIPE_PRICES: JSON.stringify({ pro: { monthly: "price_pro_m" } }),
    },
    {
      fetch: fakeFetch,
      resolveHost: async (host) =>
        host === "hooks.customer.example" ? ["93.184.216.34"] : ["10.0.0.5"],
    },
  );
  maya = h.client();
  await maya.signInAs("u_maya", "ws_lumen");
});
afterAll(() => h.close());

describe("tenant store", () => {
  it("lets a second instance catch up incrementally and see deletions", async () => {
    const other = await createApp(
      { ...h.app.config, role: "api" },
      { db: h.app.db, seed: undefined },
    );
    try {
      const before = (await other.store.read("ws_lumen")).projects.length;
      const created = (await maya.post("/projects", { name: "Seen everywhere", description: "" }))
        .body;
      const key = (await maya.post("/api-keys", { name: "temp", scopes: ["read"] })).body.key;
      let state = await other.store.read("ws_lumen");
      expect(state.projects.length).toBe(before + 1);
      expect(state.projects.at(-1)!.id).toBe(created.id);
      expect(state.apiKeys.some((k) => k.id === key.id)).toBe(true);
      // Newest-first collections keep their order across instances.
      expect(state.auditLogs[0].action).toBe("apikey.created");
      await maya.post(`/api-keys/${key.id}/revoke`);
      state = await other.store.read("ws_lumen");
      expect(state.apiKeys.some((k) => k.id === key.id)).toBe(false);
      expect(JSON.stringify(state.tasks)).toBe(
        JSON.stringify((await h.app.store.read("ws_lumen")).tasks),
      );
    } finally {
      await other.worker.stop();
      await other.bus.close();
    }
  });

  it("serialises concurrent writes to one workspace without losing any", async () => {
    const before = (await maya.get("/projects")).body.length;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        maya.post("/projects", { name: `Parallel ${i}`, description: "" }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await maya.get("/projects")).body.length).toBe(before + 12);
    h.app.store.invalidate("ws_lumen");
    expect((await maya.get("/projects")).body.length).toBe(before + 12);
  });

  it("refuses to store an entity that violates the contract and keeps the previous state", async () => {
    const write = h.app.store.write("ws_lumen", (db) => {
      (db.tasks[0] as { status: string }).status = "shipped_by_magic";
    });
    await expect(write).rejects.toThrow(/invalid tasks/);
    expect((await h.app.store.read("ws_lumen")).tasks[0].status).not.toBe("shipped_by_magic");
  });

  it("hands out immutable snapshots", async () => {
    const state = await h.app.store.read("ws_lumen");
    expect(() => state.tasks.push(state.tasks[0])).toThrow();
    expect(() => void (state.organizations[0].name = "x")).toThrow();
  });
});

describe("job queue", () => {
  it("retries with backoff, gives up after max attempts and de-duplicates by key", async () => {
    let calls = 0;
    h.app.worker.register("test.flaky", async () => {
      calls++;
      throw new Error("boom");
    });
    h.app.worker.register("test.fatal", async () => {
      throw new PermanentJobError("never");
    });
    await enqueueJob(h.app.db, { kind: "test.flaky", maxAttempts: 2 });
    await enqueueJob(h.app.db, { kind: "test.fatal" });
    await enqueueJob(h.app.db, {
      kind: "test.later",
      dedupeKey: "one",
      runAt: new Date(Date.now() + 60_000),
    });
    await enqueueJob(h.app.db, {
      kind: "test.later",
      dedupeKey: "one",
      runAt: new Date(Date.now() + 5_000),
    });
    await h.app.worker.drain();
    const rows = (
      await h.app.db.query<{ kind: string; status: string; attempts: number; run_at: Date }>(
        `SELECT kind, status, attempts, run_at FROM jobs WHERE kind LIKE 'test.%' ORDER BY id`,
      )
    ).rows;
    expect(rows.find((r) => r.kind === "test.flaky")).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(rows.find((r) => r.kind === "test.fatal")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    const later = rows.filter((r) => r.kind === "test.later");
    expect(later).toHaveLength(1);
    expect(new Date(later[0].run_at).getTime() - Date.now()).toBeLessThan(10_000);
    await h.app.db.query(`UPDATE jobs SET run_at = now() WHERE kind = 'test.flaky'`);
    await h.app.worker.drain();
    expect(calls).toBe(2);
    const final = await h.app.db.query<{ status: string }>(
      `SELECT status FROM jobs WHERE kind = 'test.flaky'`,
    );
    expect(final.rows[0].status).toBe("failed");
  });
});

describe("customer webhooks and chat notifications", () => {
  it("only accepts public https endpoints", async () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    await expect(
      assertPublicHttpsUrl("http://example.com/x", async () => ["93.184.216.34"]),
    ).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest")).rejects.toThrow(/public/);
    await expect(
      assertPublicHttpsUrl("https://internal.example/x", async () => ["10.0.0.9"]),
    ).rejects.toThrow(/public/);
    expect(
      (await maya.post("/webhook-endpoints", { url: "https://metadata.internal/hook" })).status,
    ).toBe(422);
  });

  it("delivers signed events to subscribed endpoints and notifications to Slack", async () => {
    const created = await maya.post("/webhook-endpoints", {
      url: "https://hooks.customer.example/fp",
      events: ["project.*", "suite.created"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { secret } = created.body;
    expect(JSON.stringify((await maya.get("/webhook-endpoints")).body)).not.toContain(secret);
    const slack = await maya.post("/integrations/slack/connect", {
      account: "#eng",
      credentials: { webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXX" },
    });
    expect(slack.status, JSON.stringify(slack.body)).toBe(200);
    expect(
      (
        await maya.post("/integrations/slack/connect", {
          account: "#eng",
          credentials: { webhookUrl: "https://evil.example/x" },
        })
      ).status,
    ).toBe(422);

    hooks.length = 0;
    await maya.post("/test-suites", {
      repositoryId: "repo_web",
      name: "Smoke",
      type: "unit",
      command: "npm run smoke",
      environment: "ci-sandbox",
      pathRules: ["src/**"],
      timeoutMin: 5,
      required: false,
    });
    await maya.post("/workspace", { name: "Lumen Labs" });
    // A rejected screenshot raises a notification-worthy failure path; use a direct notification instead.
    await h.app.store.write("ws_lumen", (db) => {
      db.notifications.unshift({
        id: "ntf_test",
        orgId: "ws_lumen",
        userId: null,
        kind: "approval",
        title: "Approval needed",
        body: "Agent wants to write ci.yml",
        href: "/app/approvals",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        read: false,
      });
    });
    for (let i = 0; i < 4; i++) await h.app.worker.drain();

    const delivery = hooks.find((x) => x.url.startsWith("https://hooks.customer.example/"))!;
    expect(delivery, JSON.stringify(hooks.map((x) => x.url))).toBeTruthy();
    const body = JSON.parse(delivery.body);
    expect(body).toMatchObject({ type: "suite.created", workspaceId: "ws_lumen" });
    const [t, v1] = delivery.headers["X-ForgePilot-Signature"]
      .split(",")
      .map((p) => p.split("=")[1]);
    expect(v1).toBe(hmacSha256(secret, `${t}.${delivery.body}`));
    expect(signWebhook(secret, delivery.body, Number(t))).toBe(
      delivery.headers["X-ForgePilot-Signature"],
    );
    expect(hooks.filter((x) => x.url.startsWith("https://hooks.customer.example/"))).toHaveLength(
      1,
    ); // not subscribed to audit of others
    const chat = hooks.find((x) => x.url.startsWith("https://hooks.slack.com/"))!;
    expect(JSON.parse(chat.body).text).toContain("Approval needed");
  });
});

describe("Stripe webhooks", () => {
  const stripe = new Stripe("sk_test_123");
  const send = (event: object) => {
    const payload = JSON.stringify(event);
    return h.server.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripe.webhooks.generateTestHeaderString({
          payload,
          secret: "whsec_stripe",
        }),
      },
      payload,
    });
  };
  it("changes the plan from a verified checkout event, once", async () => {
    const event = {
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          customer: "cus_1",
          subscription: "sub_1",
          client_reference_id: "ws_maya",
          metadata: { orgId: "ws_maya", plan: "pro", billingCycle: "monthly" },
        },
      },
    };
    const bad = await h.server.inject({
      method: "POST",
      url: "/api/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" },
      payload: JSON.stringify(event),
    });
    expect(bad.statusCode).toBe(400);
    expect((await send(event)).json()).toEqual({ ok: true, duplicate: false });
    expect((await send(event)).json()).toEqual({ ok: true, duplicate: true });
    await h.app.worker.drain();
    const org = (await h.app.store.read("ws_maya")).organizations[0];
    expect(org).toMatchObject({ plan: "pro", billingCycle: "monthly", trialEndsAt: null });
    const row = (
      await h.app.db.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM organizations WHERE id = 'ws_maya'`,
      )
    ).rows[0];
    expect(row.stripe_customer_id).toBe("cus_1");

    await send({
      id: "evt_2",
      object: "event",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          customer: "cus_1",
          status: "canceled",
          metadata: {},
          items: { data: [] },
        },
      },
    });
    await h.app.worker.drain();
    expect((await h.app.store.read("ws_maya")).organizations[0].plan).toBe("free");
  });
});

describe("crypto", () => {
  it("encrypts per record and binds the ciphertext to its owner", () => {
    const vault = new Vault(Buffer.alloc(32, 7).toString("base64"), { allowEphemeral: false });
    const a = vault.encrypt("secret", "ws_1:slack");
    expect(a).not.toBe(vault.encrypt("secret", "ws_1:slack"));
    expect(vault.decrypt(a, "ws_1:slack")).toBe("secret");
    expect(() => vault.decrypt(a, "ws_2:slack")).toThrow();
    expect(() => new Vault("short", { allowEphemeral: false })).toThrow(/32 bytes/);
  });
  it("hashes passwords with a salted, verifiable scheme", async () => {
    const hash = await hashPassword("pässword one two");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("pässword one two", hash)).toBe(true);
    expect(await verifyPassword("password one two", hash)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });
  it("redacts credentials from text", () => {
    const r = redactSecrets(
      "token ghp_abcdefghij1234 and sk-ant-api03-zzzzzz plus custom-secret-value",
      ["custom-secret-value"],
    );
    expect(r.text).toBe("token [REDACTED] and [REDACTED] plus [REDACTED]");
    expect(r.count).toBe(3);
  });
  it("verifies GitHub signatures over the raw body", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyGithubSignature("s", body, `sha256=${hmacSha256("s", body)}`)).toBe(true);
    expect(
      verifyGithubSignature("s", Buffer.from('{"a":2}'), `sha256=${hmacSha256("s", body)}`),
    ).toBe(false);
    expect(verifyGithubSignature("s", body, undefined)).toBe(false);
  });
});

describe("parsers", () => {
  it("reads npm and Python manifests", () => {
    const pkg = parsePackageJson(
      JSON.stringify({
        dependencies: { a: "^1.2.3", local: "file:../x" },
        devDependencies: { b: "~2.0.0" },
        scripts: { test: "vitest" },
      }),
    )!;
    expect(pkg.dependencies).toEqual([
      { name: "a", range: "^1.2.3", dev: false },
      { name: "b", range: "~2.0.0", dev: true },
    ]);
    expect(parsePackageJson("not json")).toBeNull();
    const lock = parsePackageLock(
      JSON.stringify({
        packages: {
          "": {},
          "node_modules/a": { version: "1.4.0" },
          "node_modules/x/node_modules/a": { version: "0.9.0" },
          "node_modules/@s/p": { version: "3.0.0" },
        },
      }),
    );
    expect(Object.fromEntries(lock)).toEqual({ a: "1.4.0", "@s/p": "3.0.0" });
    expect(versionFromRange(">=1.2")).toBe("1.2.0");
    expect(
      parseRequirements(
        "# c\nDjango==4.2.1\nrequests[socks]==2.31.0 ; python_version>'3'\nflask>=2\n-r other.txt\nMy_Pkg==1.0  # pinned",
      ),
    ).toEqual([
      { name: "django", version: "4.2.1" },
      { name: "requests", version: "2.31.0" },
      { name: "flask", version: null },
      { name: "my-pkg", version: "1.0" },
    ]);
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("2.0.0", "2.0")).toBe(0);
  });
  it("numbers diff lines and splits multi-file diffs", () => {
    const lines = parsePatch(
      "@@ -3,3 +3,4 @@ fn\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file",
    );
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["hunk", null, null],
      ["context", 3, 3],
      ["del", 4, null],
      ["add", null, 4],
      ["add", null, 5],
      ["context", 5, 6],
    ]);
    const files = parseUnifiedDiff(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
      true,
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["new.txt", "added", 1, 0],
      ["old.txt", "deleted", 0, 1],
    ]);
  });
  it("reads JUnit reports, ADF documents and path globs", () => {
    const cases = parseJUnit(
      '<testsuite><testcase classname="a.b" name="ok" time="0.5"/><testcase name="bad" time="1"><failure message="expected &lt;1&gt;">trace</failure></testcase><testcase name="skip"><skipped/></testcase></testsuite>',
    );
    expect(cases.map((c) => [c.name, c.outcome, c.durationMs])).toEqual([
      ["a.b › ok", "passed", 500],
      ["bad", "failed", 1000],
      ["skip", "skipped", 0],
    ]);
    expect(cases[1].error).toBe("expected <1>\ntrace");
    expect(
      adfToText({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Do it" }] },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { state: "TODO" },
                content: [{ type: "text", text: "first" }],
              },
            ],
          },
        ],
      }),
    ).toBe("Do it\n- [ ] first\n");
    expect(globToRegExp(".github/workflows/**").test(".github/workflows/a/ci.yml")).toBe(true);
    expect(globToRegExp("migrations/*.py").test("migrations/sub/x.py")).toBe(false);
    expect(globToRegExp("**/*.sql").test("db/x.sql")).toBe(true);
  });
  it("understands agent CLI event streams and builds a bounded prompt", () => {
    expect(
      claudeCode.parse(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}',
      ),
    ).toEqual([{ kind: "log", level: "tool", text: "bash npm test" }]);
    expect(
      claudeCode
        .parse(
          '{"type":"result","subtype":"error_max_turns","is_error":true,"usage":{"input_tokens":5,"output_tokens":1}}',
        )
        .at(-1),
    ).toMatchObject({ kind: "result", ok: false });
    expect(claudeCode.parse("plain text")).toEqual([]);
    expect(
      openaiCodex.parse('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'),
    ).toEqual([{ kind: "usage", tokensIn: 10, tokensOut: 2 }]);
    expect(
      claudeCode.command({ bin: "claude", prompt: "p", model: "claude-sonnet", isolated: false }),
    ).toContain("acceptEdits");
    const prompt = buildPrompt({
      title: "T",
      description: "D",
      acceptanceCriteria: ["a"],
      constraints: [],
      testCommands: ["npm test"],
      protectedPaths: ["infra/**"],
      notes: null,
    });
    expect(prompt).toContain("- a");
    expect(prompt).toContain("infra/**");
  });
  it("runs commands with an empty environment, a timeout and group kill", async () => {
    process.env.FP_LEAK_CHECK = "leak";
    const env = await runProcess("sh", ["-c", 'echo "[$FP_LEAK_CHECK][$X]"'], {
      cwd: "/tmp",
      timeoutMs: 5000,
      env: { X: "y" },
    });
    expect(env.output.trim()).toBe("[][y]");
    const slow = await runProcess("sh", ["-c", "sleep 30 & sleep 30"], {
      cwd: "/tmp",
      timeoutMs: 200,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.durationMs).toBeLessThan(5000);
  });
});

describe("one-time codes", () => {
  it("matches the RFC 6238 reference values and tolerates one step of clock drift", async () => {
    const { base32Encode, totpCode, verifyTotp } = await import("../src/platform/totp");
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (8-digit values truncated to 6).
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(secret, Math.floor(20000000000 / 30))).toBe("353130");
    const now = 1111111109_000;
    expect(verifyTotp(secret, "081804", now)).toBe(Math.floor(1111111109 / 30));
    expect(verifyTotp(secret, "081804", now + 30_000)).not.toBeNull();
    expect(verifyTotp(secret, "081804", now + 90_000)).toBeNull();
    expect(verifyTotp(secret, "08180", now)).toBeNull();
  });
});

describe("artifact storage", () => {
  it("stores, reads and removes files, and refuses keys that escape the store", async () => {
    const { LocalArtifactStore, assertSafeKey } = await import("../src/platform/artifactStore");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new LocalArtifactStore(mkdtempSync(join(tmpdir(), "fp-store-")));
    await store.put("ws_1/runs/run_1/out.log", "hello", "text/plain");
    expect((await store.get("ws_1/runs/run_1/out.log"))!.body.toString()).toBe("hello");
    expect((await store.get("ws_1/runs/run_1/out.log"))!.contentType).toBe("text/plain");
    expect(await store.get("ws_1/runs/run_1/missing.log")).toBeNull();
    await store.removePrefix("ws_1/");
    expect(await store.get("ws_1/runs/run_1/out.log")).toBeNull();
    for (const bad of ["../etc/passwd", "ws_1/../ws_2/x", "/abs/path", "ws_1//x", ""])
      expect(() => assertSafeKey(bad), bad).toThrow();
  });
});

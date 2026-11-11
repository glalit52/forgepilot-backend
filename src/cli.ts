/** Operational commands: `migrate`, `seed-demo`, `openapi`. */
import { writeFile } from "node:fs/promises";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { connectorStatus } from "./connectors/status";
import { buildOpenApi } from "./http/openapi";
import { identityRoutes } from "./identity/routes";
import { migrate } from "./platform/migrations";
import { openDatabase } from "./platform/db";

async function main() {
  const command = process.argv[2];
  const config = loadConfig({
    ...process.env,
    ROLE: "api",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  });
  if (command === "migrate") {
    const db = await openDatabase(config.databaseUrl);
    const applied = await migrate(db);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
    await db.close();
  } else if (command === "seed-demo") {
    const app = await createApp({ ...config, demoMode: true });
    await app.resetDemo();
    console.log("Demo data seeded");
    await app.close();
  } else if (command === "openapi") {
    const app = await createApp({ ...config, databaseUrl: "pglite://memory", demoMode: false });
    const doc = buildOpenApi([...identityRoutes, ...app.tenantRoutes.routes], {
      prefix: config.apiPrefix,
      version: "0.1.0",
    });
    await writeFile(process.argv[3] ?? "docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
    console.log(`Wrote ${Object.keys(doc.paths).length} paths`);
    await app.close();
  } else if (command === "doctor") {
    const icon = { ready: "READY  ", partial: "PARTIAL", off: "OFF    " };
    console.log(
      `Execution mode: ${config.execution.mode} · demo mode: ${config.demoMode ? "on" : "off"}\n`,
    );
    for (const c of connectorStatus(config)) {
      console.log(`${icon[c.state]} ${c.name}`);
      if (c.missing.length) console.log(`          missing: ${c.missing.join(", ")}`);
      if (c.state !== "ready") console.log(`          until then: ${c.whenOff}`);
    }
    console.log(
      "\nPer-workspace connectors (Claude Code, Codex, Slack, Teams, Linear, Jira) are connected by each customer in the app.",
    );
    console.log("Setup steps for everything above: docs/CONNECTORS.md");
  } else {
    console.error("Usage: cli <migrate|seed-demo|openapi [file]|doctor>");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

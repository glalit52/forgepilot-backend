// Copies the shared contract (Zod schemas, domain rules, demo data, generated endpoint list)
// from a checkout of the web app. Usage: node scripts/sync-contract.mjs ../forgepilot-frontend
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const from = process.argv[2];
if (!from) {
  console.error("Usage: node scripts/sync-contract.mjs <path to forgepilot-frontend>");
  process.exit(2);
}
cpSync(join(from, "lib/schemas"), "src/contract/schemas", { recursive: true });
for (const f of ["plans", "permissions", "health", "workflow", "integrations", "labels"])
  cpSync(join(from, `lib/domain/${f}.ts`), `src/contract/domain/${f}.ts`);
for (const f of readdirSync("src/contract/domain")) {
  const path = join("src/contract/domain", f);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll('"@/lib/schemas"', '"../schemas"'));
}
cpSync(join(from, "mocks/mock-data.json"), "seed/demo-data.json");
cpSync(join(from, "docs/api-contract.md"), "docs/ui-contract.md");
console.log(
  "Contract synced. Run `pnpm check` — the contract tests fail if an endpoint is now missing.",
);

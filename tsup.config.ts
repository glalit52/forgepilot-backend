import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  // PGlite ships WASM assets it resolves relative to its own package; keep it external.
  external: ["@electric-sql/pglite", "pg", "stripe"],
});

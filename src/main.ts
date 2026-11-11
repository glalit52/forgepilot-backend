/** Process entry point: API and/or workers depending on ROLE, with graceful shutdown. */
import { createApp } from "./app";
import { loadConfig } from "./config";
import { buildServer } from "./http/server";

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  const server = config.role === "worker" ? null : await buildServer(app);
  if (server) await server.listen({ host: config.host, port: config.port });
  app.log.info(
    { role: config.role, execution: config.execution.mode, demo: config.demoMode },
    "forgepilot backend started",
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    // Stop accepting requests first, then let in-flight jobs settle.
    await server?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

import pino, { type Logger } from "pino";

export type { Logger };

/** Structured JSON logs. Secrets never belong in log fields; the redact list is a second line of defence. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "forgepilot-backend" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.token",
        "*.secret",
        "*.apiKey",
        "*.credentials",
      ],
      censor: "[redacted]",
    },
  });
}

/** OpenAPI 3.1 document generated from the route tables, so it can never drift from the code. */
import { z } from "zod";
import type { RouteDef } from "../domain/context";
import type { GlobalRouteDef } from "../identity/routes";

type AnyRoute = Pick<
  RouteDef | GlobalRouteDef,
  "method" | "path" | "auth" | "summary" | "request" | "response"
>;

const schema = (s: z.ZodType) => z.toJSONSchema(s, { unrepresentable: "any", io: "output" });

export function authLabel(auth: string): string {
  if (auth === "public") return "None";
  if (auth === "authenticated") return "Signed-in user";
  if (auth === "member") return "Any workspace member";
  if (auth === "staff") return "ForgePilot staff";
  return `Permission \`${auth}\``;
}

export function buildOpenApi(routes: AnyRoute[], opts: { prefix: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const path = opts.prefix + r.path.replace(/:(\w+)/g, "{$1}");
    const error = { $ref: "#/components/responses/Error" };
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      description: `Access: ${authLabel(r.auth)}.`,
      security: r.auth === "public" ? [] : [{ session: [] }, { apiKey: [] }],
      parameters: params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...(r.request
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schema(r.request) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: schema(r.response) } },
        },
        "400": error,
        "401": error,
        "402": error,
        "403": error,
        "404": error,
        "409": error,
        "422": error,
        "429": error,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ForgePilot API",
      version: opts.version,
      description:
        "Control-plane API for ForgePilot. Every workspace route is scoped to the caller's active workspace; records of other workspaces answer 404.",
    },
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "fp_session" },
        apiKey: { type: "http", scheme: "bearer", description: "Workspace API key (fp_live_…)." },
      },
      responses: {
        Error: {
          description: "Error",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["error", "code", "requestId"],
                properties: {
                  error: { type: "string", description: "Human-readable message." },
                  code: { type: "string", description: "Machine-readable error code." },
                  details: {},
                  requestId: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

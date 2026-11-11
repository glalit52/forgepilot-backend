/**
 * Coding-agent adapters (PRD §15.1). Each provider is driven through its
 * supported headless CLI; an adapter only knows how to build the command line
 * and how to read that CLI's event stream. Capabilities differ per provider
 * and are declared, not assumed.
 */
import type { Provider } from "../contract/schemas";

export type AgentEvent =
  | { kind: "log"; level: "info" | "tool" | "warn" | "error" | "success"; text: string }
  | { kind: "usage"; tokensIn: number; tokensOut: number; costUsd?: number }
  | { kind: "result"; ok: boolean; summary: string };

export interface AgentCommandInput {
  bin: string;
  prompt: string;
  model: string;
  /** True when the command runs inside an isolating sandbox, so the agent may use its shell tool. */
  isolated: boolean;
}

export interface AgentAdapter {
  provider: Provider;
  /** Environment variable the provider CLI reads its API key from. */
  apiKeyEnv: string;
  /** Container image with the CLI installed. */
  image: string;
  capabilities: { reportsCost: boolean; reportsTokens: boolean };
  command(input: AgentCommandInput): string[];
  /** Parses one line of the CLI's output into zero or more events. Unknown lines are ignored. */
  parse(line: string): AgentEvent[];
}

function json(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 400) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function describeTool(name: string, input: Record<string, unknown>): string {
  const target = str(
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.description,
    160,
  );
  return target ? `${name.toLowerCase()} ${target}` : name.toLowerCase();
}

/** Claude Code in print mode with `--output-format stream-json`. */
export const claudeCode: AgentAdapter = {
  provider: "claude_code",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  image: "forgepilot/agent-claude-code:latest",
  capabilities: { reportsCost: true, reportsTokens: true },
  command({ bin, prompt, model, isolated }) {
    const args = [
      bin,
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "80",
    ];
    // Aliases the CLI understands; anything else is left to the CLI's default model.
    const alias = /opus/i.test(model)
      ? "opus"
      : /haiku/i.test(model)
        ? "haiku"
        : /sonnet/i.test(model)
          ? "sonnet"
          : null;
    if (/^claude-[a-z0-9-]+-\d/.test(model)) args.push("--model", model);
    else if (alias) args.push("--model", alias);
    if (isolated) args.push("--dangerously-skip-permissions");
    // Without a sandbox the agent may edit files but not run shell commands.
    else
      args.push("--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep");
    return args;
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    if (e.type === "assistant") {
      const content = (e.message as { content?: unknown[] } | undefined)?.content ?? [];
      const out: AgentEvent[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text" && str(block.text))
          out.push({ kind: "log", level: "info", text: str(block.text) });
        if (block.type === "tool_use")
          out.push({
            kind: "log",
            level: "tool",
            text: describeTool(str(block.name), (block.input ?? {}) as Record<string, unknown>),
          });
      }
      return out;
    }
    if (e.type === "result") {
      const usage = (e.usage ?? {}) as Record<string, unknown>;
      const ok = e.subtype === "success" && e.is_error !== true;
      return [
        {
          kind: "usage",
          tokensIn:
            num(usage.input_tokens) +
            num(usage.cache_read_input_tokens) +
            num(usage.cache_creation_input_tokens),
          tokensOut: num(usage.output_tokens),
          costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
        },
        {
          kind: "result",
          ok,
          summary:
            str(e.result, 1200) || (ok ? "Agent finished." : `Agent stopped: ${str(e.subtype)}`),
        },
      ];
    }
    return [];
  },
};

/** OpenAI Codex CLI in non-interactive mode with JSON Lines events. */
export const openaiCodex: AgentAdapter = {
  provider: "openai_codex",
  apiKeyEnv: "OPENAI_API_KEY",
  image: "forgepilot/agent-codex:latest",
  // Codex reports token counts but no price; cost stays 0 rather than being estimated.
  capabilities: { reportsCost: false, reportsTokens: true },
  command({ bin, prompt, model, isolated }) {
    const args = [bin, "exec", "--json", "--skip-git-repo-check"];
    if (/^(gpt|o\d|codex)-/i.test(model)) args.push("--model", model);
    args.push("--sandbox", isolated ? "danger-full-access" : "workspace-write", prompt);
    return args;
  },
  parse(line) {
    const e = json(line);
    if (!e) return [];
    const item = (e.item ?? {}) as Record<string, unknown>;
    if (e.type === "item.completed") {
      if (item.type === "agent_message" && str(item.text))
        return [
          { kind: "log", level: "info", text: str(item.text) },
          { kind: "result", ok: true, summary: str(item.text, 1200) },
        ];
      if (item.type === "command_execution")
        return [{ kind: "log", level: "tool", text: `run ${str(item.command, 160)}` }];
      if (item.type === "file_change") {
        const changes = (item.changes ?? []) as { path?: string }[];
        return [
          {
            kind: "log",
            level: "tool",
            text: `edit ${changes
              .map((c) => c.path)
              .filter(Boolean)
              .join(", ")
              .slice(0, 200)}`,
          },
        ];
      }
      return [];
    }
    if (e.type === "turn.completed") {
      const usage = (e.usage ?? {}) as Record<string, unknown>;
      return [
        { kind: "usage", tokensIn: num(usage.input_tokens), tokensOut: num(usage.output_tokens) },
      ];
    }
    if (e.type === "turn.failed" || e.type === "error")
      return [
        {
          kind: "result",
          ok: false,
          summary:
            str((e.error as { message?: string } | undefined)?.message ?? e.message, 600) ||
            "Agent failed",
        },
      ];
    return [];
  },
};

export const AGENT_ADAPTERS: Partial<Record<Provider, AgentAdapter>> = {
  claude_code: claudeCode,
  openai_codex: openaiCodex,
};

/** Assembles only the context the task needs (PRD §15.3). */
export function buildPrompt(input: {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  constraints: string[];
  testCommands: string[];
  protectedPaths: string[];
  notes: string | null;
}): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    `# Task\n${input.title}`,
    input.description && `## Description\n${input.description}`,
    input.acceptanceCriteria.length && `## Acceptance criteria\n${list(input.acceptanceCriteria)}`,
    input.constraints.length && `## Constraints\n${list(input.constraints)}`,
    input.notes && `## Notes from the previous attempt\n${input.notes}`,
    input.testCommands.length &&
      `## Verification\nAdd or update tests for each acceptance criterion and make these pass:\n${list(input.testCommands)}`,
    `## Rules
- Work only inside this repository checkout. Do not push, open pull requests or change git remotes: that happens after you finish.
- Do not read or print credentials, and do not add secrets to the code.
${input.protectedPaths.length ? `- These paths are protected; changing them needs human approval, so avoid it unless the task requires it: ${input.protectedPaths.join(", ")}\n` : ""}- Finish with a short summary of what you changed and how you verified it.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

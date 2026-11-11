/**
 * Process execution for the execution plane (PRD §12.4): untrusted repository
 * code and coding agents run here, never in the API process.
 *
 *  docker  — each command runs in a throwaway container: only the workspace is
 *            mounted, resources are capped, and no ForgePilot credentials are present.
 *  process — runs directly on the worker host. Only for a trusted, single-tenant
 *            worker (local development, self-hosted); it is not an isolation boundary.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for every complete line of stdout/stderr as it arrives. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Output kept in memory for the result (the tail is kept when exceeded). */
  maxOutputBytes?: number;
  stdin?: string;
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const max = opts.maxOutputBytes ?? 256 * 1024;
    let output = "";
    let timedOut = false;
    let aborted = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // Start from an empty environment: nothing from the worker leaks into the command.
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const kill = () => {
      try {
        // Negative pid: the whole process group, so grandchildren die too.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const pipe = (stream: "stdout" | "stderr") => {
      let pending = "";
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => {
        output += chunk;
        if (output.length > max) output = output.slice(-max);
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf("\n")) !== -1) {
          opts.onLine?.(pending.slice(0, nl), stream);
          pending = pending.slice(nl + 1);
        }
      });
      child[stream].on("end", () => pending && opts.onLine?.(pending, stream));
    };
    pipe("stdout");
    pipe("stderr");
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");

    const finish = (code: number | null, extra = "") => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        output: output + extra,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(127, `\n${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

export interface SandboxSpec {
  mode: "process" | "docker";
  image: string;
  /** none = no network; open = default bridge. An egress allowlist needs a proxy and is not enforced here. */
  network: "none" | "open";
  cpu: number;
  memoryGb: number;
}

/** Builds the argv that runs `shell` inside the sandbox with `workdir` as its only filesystem view. */
export function sandboxCommand(
  spec: SandboxSpec,
  workdir: string,
  shell: string,
  envNames: string[],
): { command: string; args: string[] } {
  if (spec.mode === "process") return { command: "sh", args: ["-c", shell] };
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--network",
      spec.network === "none" ? "none" : "bridge",
      "--cpus",
      String(spec.cpu),
      "--memory",
      `${spec.memoryGb}g`,
      "--pids-limit",
      "1024",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-v",
      `${workdir}:/workspace`,
      "-w",
      "/workspace",
      // Values are passed through the docker client's environment, so they never appear in argv.
      ...envNames.flatMap((name) => ["-e", name]),
      spec.image,
      "sh",
      "-c",
      shell,
    ],
  };
}

/** Converts a path glob (`**`, `*`, `?`) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): string | null {
  return globs.find((g) => globToRegExp(g).test(path)) ?? null;
}

/**
 * DevPilot task state machine, shared by UI (button enablement) and mock API
 * (allowed transitions). Guardrails from the PRD:
 *  - Review-ready only when completion conditions are met (PR + passing verification).
 *  - Passing checks never merge automatically; GitHub stays the source of truth.
 *  - Fix loops are capped (max retries) and escalate to a human.
 */
import type { TaskAction, TaskStatus, TestRunStatus } from "../schemas";

export const DEFAULT_MAX_FIX_RETRIES = 3;

const ALLOWED: Record<TaskAction, TaskStatus[]> = {
  launch: ["draft", "queued"],
  cancel: ["queued", "running", "waiting_input"],
  retry: ["failed", "cancelled", "review_ready"],
  create_pr: [],
  mark_ready: [],
  archive: ["completed", "failed", "cancelled"],
};

export interface TaskActionContext {
  status: TaskStatus;
  attempts: number;
  maxRetries?: number;
  hasAgent: boolean;
  budgetRemainingUsd?: number;
}

export function checkTaskAction(
  action: TaskAction,
  ctx: TaskActionContext,
): { allowed: boolean; reason?: string } {
  if (!ALLOWED[action].includes(ctx.status))
    return {
      allowed: false,
      reason: `Not available while the task is ${TASK_STATUS_LABEL[ctx.status].toLowerCase()}.`,
    };
  if ((action === "launch" || action === "retry") && !ctx.hasAgent)
    return { allowed: false, reason: "Choose an agent first." };
  if (action === "retry" && ctx.attempts >= (ctx.maxRetries ?? DEFAULT_MAX_FIX_RETRIES) + 1)
    return { allowed: false, reason: "Retry limit reached — a human needs to investigate." };
  if (
    (action === "launch" || action === "retry") &&
    ctx.budgetRemainingUsd !== undefined &&
    ctx.budgetRemainingUsd <= 0
  )
    return { allowed: false, reason: "Monthly budget is exhausted (hard cap)." };
  return { allowed: true };
}

/** After an agent's PR is verified, where does the task go? */
export function statusAfterVerification(run: TestRunStatus): TaskStatus {
  if (run === "passed") return "review_ready";
  if (run === "errored") return "verifying"; // infra error: rerun, never blame the change
  return "failed";
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Agent running",
  waiting_input: "Needs input",
  verifying: "Verifying",
  review_ready: "Ready for review",
  completed: "Merged",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const BOARD_COLUMNS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: "todo", label: "To do", statuses: ["draft", "queued"] },
  { key: "running", label: "In progress", statuses: ["running", "waiting_input"] },
  { key: "verifying", label: "Verifying", statuses: ["verifying"] },
  { key: "review", label: "Ready for review", statuses: ["review_ready"] },
  { key: "done", label: "Done", statuses: ["completed", "failed", "cancelled"] },
];

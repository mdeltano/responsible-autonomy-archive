import { parseArgs } from "node:util";
import type { Application } from "../application/services.js";
import type { CallerIdentity } from "../contracts/caller-context.js";
import type { TaskSummary } from "../contracts/canonical.js";
import { toPublicError } from "../contracts/errors.js";
import { ENGINE_VERSION } from "../version.js";
import { formatError, formatEvent, formatProposal, formatScenarios, formatSummary } from "./format.js";
import type { OperatorIO } from "./io.js";

// CLI commands (spec Step 7). Thin by design: parse arguments, call application services with the
// trusted caller identity from configuration, and format what comes back. Policy, authorization, and
// state transitions all live behind the services.

export interface CliContext {
  app: Application;
  // Built from configuration by the entry point; never from arguments or typed input.
  caller: CallerIdentity;
  io: OperatorIO;
  evaluationEnabled: boolean;
}

const COMMANDS: [string, string][] = [
  ["demo", "Guided interactive demo: pick a scenario, follow it, answer, approve or deny, cancel"],
  ["scenarios", "List installed synthetic scenarios"],
  ["start <scenarioId> [goal] [--key K]", "Start a task and follow it until it waits or ends"],
  ["tasks", "List recent tasks"],
  ["show <taskId>", "Show a task with its question, approval, and result"],
  ["proposal <taskId> <proposalId>", "Show a proposal: action, evidence, decision, rules"],
  ["audit <taskId> [--cursor C] [--limit N]", "Show a page of the task's audit events"],
  ["answer <taskId> <questionId> <answer...>", "Answer the task's question and follow it"],
  ["approve <taskId> <approvalId>", "Review the exact proposal and approve it (asks to confirm)"],
  ["deny <taskId> <approvalId>", "Review the exact proposal and deny it (asks to confirm)"],
  ["cancel <taskId>", "Cancel a task; committed refunds are reported, not undone"],
  ["resume", "Recover tasks interrupted by a restart and follow them"],
  ["evaluate", "Run the paired evaluation suite (Step 9; not implemented yet)"],
];

export function usage(): string {
  const width = Math.max(...COMMANDS.map(([c]) => c.length));
  return [
    `responsible-autonomy v${ENGINE_VERSION}`,
    "",
    "Usage: responsible-autonomy <command> [arguments]",
    "",
    ...COMMANDS.map(([c, d]) => `  ${c.padEnd(width)}  ${d}`),
  ].join("\n");
}

// Prints audit events the operator has not seen yet, with the full proposal after each gate decision,
// so every step shows its evidence, decision, and rules.
export class Follower {
  #lastSequence = -1;

  constructor(readonly ctx: CliContext) {}

  print(taskId: string): void {
    const { app, caller, io } = this.ctx;
    let cursor: string | undefined;
    do {
      const page = app.getAudit(caller, { taskId, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const event of page.events) {
        if (event.sequence <= this.#lastSequence) continue;
        this.#lastSequence = event.sequence;
        io.write(formatEvent(event));
        if (event.type === "decision" && event.proposalId) {
          io.write(formatProposal(app.getProposal(caller, { taskId, proposalId: event.proposalId })));
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  async follow(taskId: string): Promise<TaskSummary> {
    const summary = await this.ctx.app.waitForTask(this.ctx.caller, taskId);
    this.print(taskId);
    return summary;
  }
}

export function nextStepHint(summary: TaskSummary): string | null {
  if (summary.status === "waiting_for_information" && summary.question) {
    return `Answer with: responsible-autonomy answer ${summary.id} ${summary.question.id} <answer>`;
  }
  if (summary.status === "waiting_for_approval" && summary.approval) {
    return `Decide with: responsible-autonomy approve|deny ${summary.id} ${summary.approval.id}`;
  }
  return null;
}

async function report(ctx: CliContext, follower: Follower, taskId: string): Promise<number> {
  const summary = await follower.follow(taskId);
  ctx.io.write(formatSummary(summary));
  const hint = nextStepHint(summary);
  if (hint) ctx.io.write(hint);
  return 0;
}

// Shows the exact proposal an approval would authorize, and warns when the operator lacks the role.
// The warning is presentation only; resolveApproval enforces the role.
export function presentApproval(ctx: CliContext, taskId: string, approvalId: string): void {
  const { app, caller, io } = ctx;
  const approval = app.getTask(caller, { taskId }).approval;
  if (approval?.id !== approvalId) return;
  io.write(formatProposal(app.getProposal(caller, { taskId, proposalId: approval.proposalId })));
  if (!caller.roles.includes(approval.requiredRole)) {
    io.write(
      `You are ${caller.actorId} without the ${approval.requiredRole} role, so a decision will be rejected. ` +
        "In this local demo, roles come from LOCAL_ROLES (a demo assumption, not authentication).",
    );
  }
}

// Shows the exact proposal and asks the operator to type the decision. Only that typed confirmation,
// through this explicit interface, reaches resolveApproval (spec Step 5, Step 7).
async function confirmAndDecide(ctx: CliContext, taskId: string, approvalId: string, decision: "approve" | "deny"): Promise<boolean> {
  presentApproval(ctx, taskId, approvalId);
  const typed = await ctx.io.ask(`Type "${decision}" to ${decision} this exact proposal, anything else to abort: `);
  if (typed?.trim() !== decision) {
    ctx.io.write("Aborted; nothing was changed.");
    return false;
  }
  ctx.app.resolveApproval(ctx.caller, { taskId, approvalId, decision });
  return true;
}

export async function runCommand(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const { app, caller, io } = ctx;
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      key: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  const follower = new Follower(ctx);
  // The first `count` arguments are checked present; the cast only records that for the compiler.
  const need = (count: 1 | 2 | 3, shape: string) => {
    if (args.length < count) throw new UsageError(`Usage: responsible-autonomy ${command} ${shape}`);
    return args as [string, string, string, ...string[]];
  };

  switch (command) {
    case undefined:
      io.write(usage());
      return values.help ? 0 : 2;
    case "scenarios":
      io.write(formatScenarios(app.listScenarios(caller)));
      return 0;
    case "start": {
      const [scenarioId, ...goalWords] = need(1, "<scenarioId> [goal] [--key K]");
      const scenario = app.listScenarios(caller).find((s) => s.id === scenarioId);
      const goal = goalWords.length > 0 ? goalWords.join(" ") : (scenario?.suggestedGoal ?? "");
      const started = app.startTask(caller, { scenarioId, goal, ...(values.key === undefined ? {} : { idempotencyKey: values.key }) });
      io.write(`Started task ${started.id}.`);
      return report(ctx, follower, started.id);
    }
    case "tasks": {
      const tasks = app.listTasks(caller);
      io.write(tasks.length === 0 ? "No tasks." : tasks.map((t) => `  ${t.id}  ${t.status.padEnd(23)} ${t.updatedAt}`).join("\n"));
      return 0;
    }
    case "show": {
      const [taskId] = need(1, "<taskId>");
      const summary = app.getTask(caller, { taskId });
      io.write(formatSummary(summary));
      const hint = nextStepHint(summary);
      if (hint) io.write(hint);
      return 0;
    }
    case "proposal": {
      const [taskId, proposalId] = need(2, "<taskId> <proposalId>");
      io.write(formatProposal(app.getProposal(caller, { taskId, proposalId })));
      return 0;
    }
    case "audit": {
      const [taskId] = need(1, "<taskId> [--cursor C] [--limit N]");
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      const page = app.getAudit(caller, {
        taskId,
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      io.write(page.events.map(formatEvent).join("\n") || "No events.");
      if (page.nextCursor) io.write(`More: responsible-autonomy audit ${taskId} --cursor ${page.nextCursor}`);
      return 0;
    }
    case "answer": {
      const [taskId, questionId, ...words] = need(3, "<taskId> <questionId> <answer...>");
      app.answerQuestion(caller, { taskId, questionId, answer: words.join(" ") });
      return report(ctx, follower, taskId);
    }
    case "approve":
    case "deny": {
      const [taskId, approvalId] = need(2, "<taskId> <approvalId>");
      if (!(await confirmAndDecide(ctx, taskId, approvalId, command))) return 1;
      return report(ctx, follower, taskId);
    }
    case "cancel": {
      const [taskId] = need(1, "<taskId>");
      io.write(formatSummary(await app.cancelTask(caller, { taskId })));
      return 0;
    }
    case "resume": {
      const count = app.recoverInterruptedTasks();
      io.write(count === 0 ? "No interrupted tasks." : `Recovered ${count} task(s).`);
      for (const task of app.listTasks(caller).filter((t) => t.status === "queued" || t.status === "running")) {
        await report(ctx, new Follower(ctx), task.id);
      }
      return 0;
    }
    case "evaluate":
      if (!ctx.evaluationEnabled) {
        io.error("Evaluation is disabled. Set EVALUATION_ENABLED=true to run it.");
        return 1;
      }
      // Honest status: an unimplemented command fails rather than pretending to succeed.
      io.error("'evaluate' is not implemented yet (Step 9). See docs/STATUS.md.");
      return 1;
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${usage()}`);
  }
}

export class UsageError extends Error {
  override name = "UsageError";
}

// Runs one CLI invocation and returns its exit code: 0 success, 1 failure, 2 usage error.
export async function runCli(ctx: CliContext, argv: readonly string[], demo: (ctx: CliContext) => Promise<number>): Promise<number> {
  try {
    if (argv[0] === "demo") return await demo(ctx);
    return await runCommand(ctx, argv);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      ctx.io.error(error.message);
      return 2;
    }
    ctx.io.error(formatError(toPublicError(error)));
    return 1;
  }
}

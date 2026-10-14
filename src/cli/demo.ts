import { isTerminalStatus } from "../contracts/canonical.js";
import { AppError, toPublicError } from "../contracts/errors.js";
import { Follower, nextStepHint, presentApproval, type CliContext } from "./commands.js";
import { formatError, formatScenarios, formatSummary } from "./format.js";

// Guided local demo (spec Step 7, §Demo and portfolio deliverables). Lists scenarios, submits a goal,
// shows each step's evidence and gate decision, asks the operator for answers and approval decisions,
// supports cancellation, and ends with the verified outcome. Every decision it relays is typed by the
// operator; nothing the planner or the records say can stand in for that input.

const DISCLOSURE = [
  "Responsible Autonomy local demo. All data is synthetic; no real payment or message is involved.",
  "Planner: offline rule-based fake. With a real provider (Step 8), the goal and relevant synthetic",
  "records would be sent to that provider.",
  "Demo assumption: your identity and roles come from LOCAL_OWNER_ID, LOCAL_ACTOR_ID, and LOCAL_ROLES.",
  "That is local configuration, not authentication.",
];

const MAX_ATTEMPTS = 3;

export async function runDemo(ctx: CliContext): Promise<number> {
  const { app, caller, io } = ctx;
  for (const line of DISCLOSURE) io.write(line);
  const canApprove = caller.roles.length > 0 ? caller.roles.join(", ") : "none";
  io.write(`You are ${caller.actorId} (roles: ${canApprove}).`);
  io.write("");

  const scenarios = app.listScenarios(caller);
  io.write("Installed scenarios:");
  io.write(formatScenarios(scenarios));
  let scenario;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !scenario; attempt++) {
    const choice = await io.ask("Choose a scenario by number or ID: ");
    if (choice === null) return 1;
    const trimmed = choice.trim();
    scenario = scenarios[Number(trimmed) - 1] ?? scenarios.find((s) => s.id === trimmed);
    if (!scenario) io.write("No such scenario.");
  }
  if (!scenario) return 1;

  const suggested = scenario.suggestedGoal ?? "";
  const typed = await io.ask(`Goal${suggested ? ` [${suggested}]` : ""}: `);
  if (typed === null) return 1;
  const goal = typed.trim() === "" ? suggested : typed;

  const started = app.startTask(caller, { scenarioId: scenario.id, goal });
  io.write(`\nStarted task ${started.id}. Progress:`);
  const follower = new Follower(ctx);

  for (;;) {
    const summary = await follower.follow(started.id);
    if (isTerminalStatus(summary.status)) {
      io.write("");
      io.write(formatSummary(summary));
      return 0;
    }
    try {
      if (summary.status === "waiting_for_information" && summary.question) {
        io.write(`\nQuestion: ${summary.question.text}`);
        if (summary.question.options.length > 0) io.write(`  Options: ${summary.question.options.join(", ")}`);
        const answer = await io.ask("Your answer ('cancel' to cancel, Enter to leave it waiting): ");
        if (answer === null || answer.trim() === "") return leaveWaiting(ctx, summary);
        if (answer.trim() === "cancel") await app.cancelTask(caller, { taskId: summary.id });
        else app.answerQuestion(caller, { taskId: summary.id, questionId: summary.question.id, answer });
      } else if (summary.status === "waiting_for_approval" && summary.approval) {
        io.write("\nApproval required for this exact proposal:");
        presentApproval(ctx, summary.id, summary.approval.id);
        const choice = await io.ask("approve / deny / cancel, or Enter to leave it waiting: ");
        const action = choice?.trim() ?? "";
        if (action === "approve" || action === "deny") {
          // Typing the decision after seeing the exact proposal is the explicit confirmation.
          app.resolveApproval(caller, { taskId: summary.id, approvalId: summary.approval.id, decision: action });
        } else if (action === "cancel") {
          await app.cancelTask(caller, { taskId: summary.id });
        } else {
          return leaveWaiting(ctx, summary);
        }
      } else {
        return leaveWaiting(ctx, summary);
      }
    } catch (error) {
      // A rejected decision (no role, a stale approval) is reported and the task is followed again.
      if (!(error instanceof AppError)) throw error;
      io.write(formatError(toPublicError(error)));
      if (error.code === "UNAUTHORIZED") return leaveWaiting(ctx, app.getTask(caller, { taskId: summary.id }));
    }
  }
}

function leaveWaiting(ctx: CliContext, summary: Parameters<typeof nextStepHint>[0]): number {
  ctx.io.write("");
  ctx.io.write(formatSummary(summary));
  const hint = nextStepHint(summary);
  if (hint) ctx.io.write(`The task stays waiting. ${hint}`);
  return 0;
}

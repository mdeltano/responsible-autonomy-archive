import { isTerminalStatus, taskSummary, type TaskSummary } from "../contracts/canonical.js";
import { latestApprovalForTask } from "../storage/approvals.js";
import type { Database } from "../storage/database.js";
import { latestQuestionForTask } from "../storage/questions.js";
import type { TaskRecord } from "../storage/tasks.js";

// TaskSummary from stored records (spec §Canonical contracts). The question is shown while it waits
// for an answer and after it is answered; the approval is the latest one in any status.
export function summarize(db: Database, task: TaskRecord): TaskSummary {
  const latestQuestion = latestQuestionForTask(db, task.id)?.question ?? null;
  const question =
    latestQuestion && (latestQuestion.answer !== null || task.status === "waiting_for_information") ? latestQuestion : null;
  const latestApproval = latestApprovalForTask(db, task.id)?.approval ?? null;
  const approval = latestApproval?.status === "pending" && task.status !== "waiting_for_approval" ? null : latestApproval;
  const warnings: string[] = [];
  if (task.cancelRequested && !isTerminalStatus(task.status)) warnings.push("Cancellation was requested.");
  return taskSummary.parse({
    id: task.id,
    status: task.status,
    stage: task.stage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    question,
    approval,
    result: task.result,
    warnings,
  });
}

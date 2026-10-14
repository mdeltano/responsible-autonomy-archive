import { question, type Question } from "../contracts/canonical.js";
import type { Database } from "./database.js";
import { json, text, textOrNull } from "./rows.js";

// Clarification questions (spec §Agent control loop, Step 6). Answers are untrusted user text: they
// are stored as data and can never expand scope or override policy.

export interface StoredQuestion {
  question: Question;
  createdAt: string;
  answeredAt: string | null;
}

function toQuestion(row: Record<string, unknown>): StoredQuestion {
  return {
    question: question.parse({
      id: text(row, "id"),
      taskId: text(row, "task_id"),
      missingPreconditionIds: json(row, "missing_precondition_ids_json"),
      text: text(row, "text"),
      options: json(row, "options_json"),
      answer: textOrNull(row, "answer"),
    }),
    createdAt: text(row, "created_at"),
    answeredAt: textOrNull(row, "answered_at"),
  };
}

export function insertQuestion(db: Database, input: { question: Question; createdAt: string }): void {
  const q = question.parse(input.question);
  if (q.answer !== null) throw new Error("New questions start unanswered");
  db.prepare(
    `INSERT INTO questions (id, task_id, missing_precondition_ids_json, text, options_json, answer, created_at, answered_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(q.id, q.taskId, JSON.stringify(q.missingPreconditionIds), q.text, JSON.stringify(q.options), input.createdAt);
}

export function readQuestion(db: Database, id: string): StoredQuestion | null {
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
  return row ? toQuestion(row) : null;
}

export function latestQuestionForTask(db: Database, taskId: string): StoredQuestion | null {
  const row = db
    .prepare("SELECT * FROM questions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(taskId);
  return row ? toQuestion(row) : null;
}

export function openQuestionForTask(db: Database, taskId: string): StoredQuestion | null {
  const row = db.prepare("SELECT * FROM questions WHERE task_id = ? AND answer IS NULL").get(taskId);
  return row ? toQuestion(row) : null;
}

export function countQuestions(db: Database, taskId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id = ?").get(taskId);
  return Number(row?.n ?? 0);
}

// Only the first answer counts.
export function recordAnswer(db: Database, input: { id: string; answer: string; now: string }): boolean {
  const update = db
    .prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL")
    .run(input.answer, input.now, input.id);
  return update.changes === 1;
}

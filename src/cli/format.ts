import type { ProposalView, ScenarioDescription } from "../application/services.js";
import type { AuditEvent, TaskSummary } from "../contracts/canonical.js";
import type { PublicError } from "../contracts/errors.js";

// Plain-text rendering for the CLI (spec Step 7, §Demo and portfolio deliverables). Display only: it
// shows the proposed action, evidence, gate decision, rules, and verified outcome, and decides nothing.

// USD has two minor-unit digits; other currencies are shown in minor units rather than guessing an
// exponent. String-based, so no floating point touches money.
export function formatMoney(amountMinor: number, currency: string): string {
  if (currency !== "USD") return `${amountMinor} ${currency} minor units`;
  const digits = String(amountMinor).padStart(3, "0");
  return `$${digits.slice(0, -2)}.${digits.slice(-2)} (${amountMinor} USD minor units)`;
}

export function formatScenarios(scenarios: readonly ScenarioDescription[]): string {
  return scenarios.map((s, i) => `  ${i + 1}. ${s.id} - ${s.title}\n     ${s.description}`).join("\n");
}

export function formatEvent(event: AuditEvent): string {
  const rules = event.ruleIds.length > 0 ? ` [${event.ruleIds.join(", ")}]` : "";
  return `  #${String(event.sequence).padStart(2, "0")} ${event.type.padEnd(12)} ${event.result.padEnd(8)} ${event.summary}${rules}`;
}

export function formatProposal(view: ProposalView): string {
  const p = view.proposal;
  const action =
    p.tool === "commit_refund"
      ? `Refund ${formatMoney(p.arguments.amountMinor, p.arguments.currency)} on order ${p.arguments.orderId} to the original payment${view.destination ? ` (${view.destination})` : ""}`
      : `Record resolution note on order ${p.arguments.orderId}: "${p.arguments.note}"`;
  const missing = p.preconditions.filter((c) => c.status !== "satisfied");
  const lines = [
    `  Proposal ${p.id} (${p.tool})`,
    `    Action:    ${action}`,
    `    Decision:  ${p.decision}   Rules: ${p.ruleIds.join(", ") || "none"}`,
    `    Why:       ${p.explanation || "-"}`,
    `    Missing:   ${missing.length === 0 ? "none" : missing.map((c) => `${c.id} (${c.status})`).join(", ")}`,
    `    Policy:    ${p.policyVersion}   Records: ${Object.entries(p.stateVersions).map(([id, v]) => `${id}@v${v}`).join(", ") || "none"}`,
    `    Digest:    ${p.actionDigest}`,
    "    Evidence:",
    ...(view.evidence.length === 0 ? ["      (none)"] : view.evidence.map((e) => `      - ${e.sourceId}${e.recordVersion === null ? "" : `@v${e.recordVersion}`}: ${e.statement}`)),
  ];
  if (view.approval) lines.push(`    Approval:  ${view.approval.id} ${view.approval.status} (role ${view.approval.requiredRole}, expires ${view.approval.expiresAt})`);
  if (view.operation) lines.push(`    Operation: ${view.operation.id} ${view.operation.status}`);
  return lines.join("\n");
}

export function formatSummary(summary: TaskSummary): string {
  const lines = [`Task ${summary.id}: ${summary.status} (${summary.stage})`];
  if (summary.question) {
    lines.push(`  Question ${summary.question.id}: ${summary.question.text}`);
    if (summary.question.options.length > 0) lines.push(`    Options: ${summary.question.options.join(", ")}`);
    if (summary.question.answer !== null) lines.push(`    Answer: ${summary.question.answer}`);
  }
  if (summary.approval) {
    const a = summary.approval;
    lines.push(`  Approval ${a.id}: ${a.status} for proposal ${a.proposalId} (role ${a.requiredRole}, expires ${a.expiresAt})`);
  }
  if (summary.result) {
    const r = summary.result;
    lines.push(`  Outcome: ${r.outcome}`);
    lines.push(`  Operations: ${r.operationIds.join(", ") || "none"}`);
    lines.push(`  Verified against ledger: ${r.verified ? "yes" : "no"}`);
    lines.push(`  Limitations: ${r.limitations.length === 0 ? "none" : r.limitations.join(" ")}`);
  }
  for (const warning of summary.warnings) lines.push(`  Warning: ${warning}`);
  return lines.join("\n");
}

export function formatError(error: PublicError): string {
  return `Error [${error.code}]${error.retryable ? " (retryable)" : ""}: ${error.message}`;
}

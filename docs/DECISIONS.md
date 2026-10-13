# Decisions and spec deviations

Record tooling choices the spec leaves open, and any deliberate deviation from [SPEC.md](SPEC.md),
newest first. Each entry: date, decision, spec section affected, reason.

## 2026-10-13 — Step 2 trusted caller context

- **Split context:** `CallerIdentity` (`ownerId`, `actorId`, roles, permissions) is rebuilt from config
  on every call, so a revoked role takes effect immediately. `CustomerScope` (authorized `customerIds`,
  plus an optional `orderIds` narrowing) is bound with the identity into a frozen `CallerContext`
  snapshot when the task starts. Later calls take roles and permissions from the current identity and
  scope from the snapshot, so nothing after task start can widen scope. A caller whose owner differs
  from the snapshot's gets `NOT_FOUND`. Spec Step 2.
- **Scope source:** the trusted section of the scenario definition (Step 3 fixtures) supplies the task's
  customer scope, as in the spec's worked example, where the coordinator supplies it. Goals, answers,
  and notes never do.
- **Order access:** an order is in scope only when its owning customer, as read from the trusted record,
  is authorized. Knowing an order ID grants nothing. Spec §Internal agent tools.
- **Permissions:** the local operator always holds `task:start`, `task:read`, `task:answer`, and
  `task:cancel`, and holds `evaluation:run` only when `EVALUATION_ENABLED=true`. Approval authority is
  role-based (`requireRole` against `Approval.requiredRole`), not a permission. Default roles are empty.

## 2026-10-13 — Completion checks for `finish` (target for Step 6)

The spec accepts `finish` "only after application-side completion checks confirm the outcome" but does
not list the checks. The owner chose the following definition. The coordinator marks a task
`completed` only when all of these hold, judged from records and never from model text:

1. An accepted `propose_resolution` exists for an order inside the task's trusted scope.
2. The resolution is backed by facts:
   - **refund:** the exact proposal was committed, and `verify_refund` confirmed the ledger
     (`verified: true`, amount and currency match the proposal).
   - **no_refund:** the deterministic eligibility check reports the order ineligible, or the ledger
     shows the refund already completed.
3. No unanswered question, pending approval, or operation with an unknown acknowledgment remains.
4. No action outside the case was taken (R14).
5. `record_resolution` stored an outcome note for the order. Spec §Version 1 scope lists "record an
   outcome" as a required action.

If any check fails while budget remains, the finish is rejected, the planner is told which checks are
unmet, and the loop continues. Otherwise the terminal status is `refused` (policy blocks the goal and no
permitted alternative exists), `partial` (useful work but goal unfinished, including budget exhaustion,
timeout, and expired waits), `failed` (no useful work or an unrecoverable error), or `cancelled`
(operator stop; any committed refund is still reported with its verified outcome). The model never
supplies the status. Spec Step 6, §Reliability and limits.

## 2026-10-13 — Step 2 service inputs and planner contract

- **Planner output variants:** the spec lists `tool_call`, `ask_question`, `propose_resolution`, and
  `finish` but does not define them.
  - `tool_call` wraps one of the eight allowlisted tools from spec §Internal agent tools, with that
    tool's argument schema. There is no approval tool.
  - `propose_resolution` is the planner's case-level conclusion: `{orderId, resolution: refund |
    no_refund, reason}`. It has no effect on its own, and the coordinator accepts it only when verified
    facts support it.
  - `finish` carries a summary and no status. The application decides the terminal status.

  To be revisited in Step 6 if the coordinator needs more. Spec Step 6.
- **Rationale:** every planner variant requires a `rationale` of 1–500 characters. This is the "concise
  operational rationale" of spec Step 8, and it is shorter than the 2000-character narrative cap.
- **commit_refund arguments** are only `{proposalId}`. The planner cannot supply an idempotency key.
  Spec §Policy rules.
- **Service field names the spec leaves open:** `resolveApproval.decision` is `approve | deny`, and
  `startEvaluation.split` is `development | held_out`. No service input carries caller identity or roles.
  Spec §Application service interface.
- **Blank text:** goals and answers must contain a non-whitespace character, so padding cannot satisfy
  the minimum length.

## 2026-10-13 — Step 2 canonical contracts

- **Tool-specific proposal arguments:** `ActionProposal` is a discriminated union on `tool`.
  `commit_refund` carries `{orderId, amountMinor, currency, reason}` (the refund that `propose_refund`
  requested), and `record_resolution` carries `{orderId, note}`. Neither has a destination field, so
  refunds can only go to the original payment. Spec §Canonical contracts, Step 2.
- **Cross-field invariants beyond the spec's types**, enforced by zod at runtime (JSON Schema cannot
  express them):
  - `targetId` must equal `arguments.orderId`.
  - `AUTO_EXECUTE` and `HUMAN_APPROVAL` require every precondition to be `satisfied`.
  - Record evidence must carry a `recordVersion`.
  - `approverId` is set exactly when an approval is `approved` or `denied`.
  - A question is tied to at least one missing precondition.
  - `TaskSummary`: a result is present exactly for terminal statuses, and `completed` requires
    `verified: true`. The waiting statuses pair with an unanswered question or a pending approval.
    `updatedAt` must not precede `createdAt`.

  Spec §Product behavior, §Policy rules, §Definition of done.
- **Size caps where the spec gives none:** `stateVersions` holds at most 20 entries, `stage` is 1–64
  characters, and question options are 1–200 characters each.

## 2026-10-13 — Step 2 contract primitives

- **Opaque ID character set:** the spec requires IDs to be opaque strings of 1–128 characters. IDs and
  idempotency keys are further limited to `[A-Za-z0-9][A-Za-z0-9._:-]*`, so they can appear verbatim in
  logs, idempotency keys, and error messages without escaping. Config's `LOCAL_OWNER_ID` and
  `LOCAL_ACTOR_ID` use the same schema. Spec §Application service interface.
- **Error retryability:** `STATE_CONFLICT`, `PROVIDER_UNAVAILABLE`, and `TIMEOUT` default to
  `retryable: true`, and all other codes default to false. Retrying a `STATE_CONFLICT` means a fresh read
  and a new proposal, never a repeat of the same write. Spec §Reliability and limits.
- **Error messages:** `INVALID_INPUT` names failing paths and rules but never echoes input values, and
  it is truncated because key names are untrusted. `NOT_FOUND` uses one fixed message that does not echo
  the requested ID. Spec §Security and privacy.
- **Money:** a `Money` value is `{amountMinor, currency}` with checked safe-integer arithmetic. A
  currency mismatch or a negative result throws `RangeError` as an invariant violation, because the gate
  must reject such proposals before any arithmetic runs. Spec §Policy rules.

## 2026-10-12 — Baseline: Responsible Autonomy guide v2.0 (no MCP)

- **Identity:** Project Sundance implements the *Responsible Autonomy Engineering Requirements and
  Implementation Guide* v2.0 ([SPEC.md](SPEC.md)). It replaces a short-lived MCP-server descriptor for
  the same project, which the owner discarded. Earlier BlindSpot
  scaffolding was removed; it is a separate project.
- **No MCP:** the guide requires no protocol adapter. `@modelcontextprotocol/sdk` was uninstalled, and the
  stdio server entry point was replaced by a local CLI at `src/cli/main.ts`. Spec §Architecture, Step 7.
- **Layout and scripts** follow spec Step 1 exactly. Fixtures live in `fixtures/public` (model-visible)
  and `fixtures/expected` (hidden oracle), and tests in `tests/`.
- **Env names** follow spec Step 1 (`MODEL_PROVIDER`, `MODEL_ID`, `MODEL_API_KEY`, `DATABASE_PATH`,
  `MAX_TOKENS_PER_TASK`, `EVALUATION_ENABLED`). Other limits use the same unprefixed style.
  `MODEL_API_KEY` is the "provider credential placeholder". Config keeps it out of the returned object
  while the fake provider is selected, and never echoes values in errors.
- **Token budget:** the spec calls it "mandatory configured", but Step 1's exit criterion requires that
  no provider call be needed. Config therefore requires a positive `MAX_TOKENS_PER_TASK` whenever a real
  provider is selected, and the offline fake planner may run without one. Spec §Reliability and limits,
  Step 1.
- **Demo identity:** `LOCAL_OWNER_ID`, `LOCAL_ACTOR_ID`, and `LOCAL_ROLES` feed CallerContext for the local
  demo. This is documented as a demo assumption, not authentication. Default roles are empty, so approval
  requires deliberately configuring `refund_approver`. Spec §Policy rules, Step 2.
- **Currency thresholds** (5000 minor units for USD auto-execute) live in the versioned policy file
  (`POLICY_PATH`), not env vars, so threshold and policy version change together. Spec §Policy rules.
- **Unimplemented CLI commands** (`demo`, `evaluate`) exit non-zero with a clear message rather than
  appearing to succeed (honest status). `test:integration` uses `--passWithNoTests` until integration
  tests exist.

## 2026-10-12 — Initial stack

- **Runtime schemas:** zod 4.6.7. Built-in `z.toJSONSchema` satisfies the JSON Schema generation
  requirement without an extra dependency. Spec §Canonical contracts.
- **SQLite:** Node's built-in `node:sqlite` (`DatabaseSync`) instead of `better-sqlite3`. Avoids a native
  build on Windows and adds no dependency. Requires Node >= 22.13. Synchronous transactions suit the
  atomic commit requirement. Spec §Policy rules, Step 3.
- **Node:** `engines` allows >= 22.13, which covers the 22 and 24 LTS lines the spec asks for.
  Development currently runs on Node 25. Spec Step 1.
- **TypeScript:** 7.0.2 (native compiler, strict mode). Tests run through vitest 4.1.11, and the CLI
  scripts run from source through `tsx`.
- **Package manager:** npm with a committed `package-lock.json`. Dependencies are pinned exactly.

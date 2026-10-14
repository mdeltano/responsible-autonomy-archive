# Decisions and spec deviations

Record tooling choices the spec leaves open, and any deliberate deviation from [SPEC.md](SPEC.md),
newest first. Each entry: date, decision, spec section affected, reason.

## 2026-10-14 — Step 7 local demonstration interface

- **Shape (owner decision):** a guided `demo` plus one-shot subcommands (`scenarios`, `start`, `tasks`,
  `show`, `proposal`, `audit`, `answer`, `approve`, `deny`, `cancel`, `resume`). A task waiting for an
  answer or approval can be picked up in a later session. Every command that resumes a task follows it
  until it waits or ends, then exits. Spec Step 7.
- **Thin interface:** `src/cli` parses arguments, builds the caller identity from configuration, calls
  the services, and formats results. The "you lack the role" note before an approval prompt is only
  presentation. `resolveApproval` enforces the role.
- **Explicit confirmation:** `approve` and `deny` show the exact proposal (amount, original destination,
  decision, rules, record versions, digest, evidence) and require the operator to type the decision word.
  In the guided demo, typing `approve` or `deny` at the approval prompt, after the proposal has been
  shown, is that confirmation. Operator input goes through an injected `OperatorIO`, so tests play the
  operator through the same channel. Spec Step 5, Step 7.
- **Configuration:** the CLI loads `.env` when present (`process.loadEnvFile`, which does not override
  variables already set). This makes the demo role assumption (`LOCAL_ROLES=refund_approver`) easy to
  set on any platform. `FIXTURES_DIR` (default `./fixtures/public`) names the scenarios offered. Hidden
  expected outcomes are never loaded by the CLI.
- **Exit codes:** 0 success, 1 a typed application error or an aborted confirmation, 2 a usage error.
  Errors go to stderr as `Error [CODE]: message`.
- **Planner:** the CLI uses the offline rule-based fake planner until Step 8. The banner says no
  provider receives anything, and that a real provider would receive the goal and relevant records.

## 2026-10-14 — Step 6 coordinator, services, and fake planners

- **Planner contract:** a planner receives a versioned prompt ID, trusted instructions, the goal
  (untrusted), the trusted scope, a policy summary, the tool list, the last 30 history entries, the
  remaining budgets, and repair issues on a repair attempt. History holds validated outputs, engine
  results, and events (answer received, approval decided, commit reconciled). Record text appears only
  in fields marked untrusted (`untrustedNotes`, `untrustedAnswer`). Spec Step 6, Step 8.
- **Budgets:** every planner request counts as a planning step, including provider retries and the
  repair attempt (spec: "consume the same budget"). One schema repair is allowed per invalid response,
  and a second invalid response stops the task with nothing executed. Budgets are checked before every
  request and every action. Counters live in the checkpoint, so a restart does not reset them. A token
  cap of 0 means none, which applies only to the offline fake planner (see "Token budget").
- **Finish:** a finish with unmet completion checks is rejected with the unmet list. The second
  rejection ends the task. `propose_resolution` is accepted only when checks 1–2 hold.
- **Terminal classification** (`stopStatus`):
  - Finish rejected: `refused` when the gate refused a refund or a lookup was refused for scope and no
    refund was committed; otherwise `partial` when useful work exists, else `failed`.
  - Budget or time exhausted: `partial` or `failed`, never `refused` or `completed`, even if every
    check happens to hold.
  - Invalid output or error: `failed`, or `partial` if a refund was committed.
  - Expired wait: `partial`.
- **Result `verified`:** every refund operation the task committed is verified against the ledger at
  finalization (true when there are none). Finalization settles in-flight commits and runs
  `verify_refund` on any committed refund first. A `completed` whose ledger does not reconcile is
  reported as `partial`.
- **Questions:** a question must target known preconditions: the gate's, plus `pre_target_order` and
  `pre_customer_identity`. Its TTL (`PENDING_TASK_TTL_MS`) counts from when it was asked. Questions
  beyond `MAX_QUESTIONS` are rejected without pausing.
- **Runner:** an in-process runner allows `MAX_ACTIVE_TASKS` loops per owner and `MAX_QUEUED_TASKS`
  queued. Tasks that will take a free slot on the next tick do not count against the queue. Overflow is a
  retryable `BUDGET_EXCEEDED`. A task is never queued or run twice at once. Resume and cancel events are
  conditional status updates, so only one can win.
- **Restart recovery:** `recoverInterruptedTasks` re-queues tasks left `running` by a dead process. The
  coordinator settles in-flight commits by lookup before planning. This assumes **one process per
  database**. Concurrent CLI processes on one database are not supported.
- **Cancellation:** sets a flag, aborts an in-flight planner request, and finalizes as `cancelled`. A
  committed refund is verified and reported. A pending approval is invalidated. Cancelling a finished
  task is a non-retryable `STATE_CONFLICT`.
- **Audit actors:** actions the engine takes for the planner are recorded as actor `agent`. Operator
  actions (start, answer, approve, deny, cancel) use the operator's actor ID.
- **Evidence:** the engine writes it. Record evidence states structured facts and versions. Order notes
  are never copied into evidence. Answers become `user_statement` evidence.
- **Extra services:** `listTasks` (so a later session can find waiting tasks) and `waitForTask` (so an
  interface can follow a task) are not in the spec's table. Both are read-only and owner-scoped.
- **Fake planners:** `ScriptedPlanner` (tests) replays outputs and can call functions or fall back to
  another planner. `RuleBasedPlanner` (demo) follows the refund workflow from history alone and never
  reads notes. Adversarial behavior is tested with scripted planners.

## 2026-10-14 — Step 5 approvals and atomic execution

- **When approval is requested:** `propose_refund` runs the gate. On `HUMAN_APPROVAL` it stores a
  pending approval bound to the proposal's digest, policy version, and record versions, and the task
  pauses. After approval, the task resumes and the planner calls `commit_refund`, as the tool table
  says. Spec §Internal agent tools, Step 5.
- **Denial ends the task (owner decision):** a denial records the approver and ends the task as
  `refused` ("approver denied proposal X; no refund was made"). The planner is not called again, so it
  cannot route around the approver with a smaller refund. Spec §Policy rules.
- **Two checks before writing:** `commit_refund` first checks the stored proposal against fresh records
  (gate decision, policy version, digest, approval status and expiry), then runs the same check inside
  the commit transaction through the `recheck` hook. The first check gives a precise answer and
  invalidates a stale approval. The second closes the race.
- **Invalidation:** a stale proposal (changed records, changed decision, changed policy) invalidates
  its approval, whether pending or granted. Invalidation clears `approverId`, because the contract sets
  it only for approved or denied. The audit log keeps who approved. `resolveApproval` runs the same check
  when an operator tries to approve. If the approval is stale, it is invalidated, the task resumes to
  form a new proposal, and the operator gets `STATE_CONFLICT`. R07.
- **Approval checks in order:** unknown or foreign IDs get NOT_FOUND, then the role is checked, then
  expiry and status. A foreign approval therefore reveals nothing, even to a caller without the role. An
  approved proposal whose approval has since expired gets `APPROVAL_EXPIRED` at commit.
- **Commit attempts:** before a refund commit, a `commit_attempts` row is marked in flight in its own
  transaction. If the commit fails with anything other than a rejection inside the transaction, the
  engine looks the operation up by proposal. If found, it reports it (`reconciled: true`) and writes
  nothing. If not found, the failure is reported as retryable, and retrying the same proposal is safe.
  While an attempt is unresolved, the gate sees an unknown prior outcome and returns VERIFY_FIRST. R08.
- **Proposals for refused actions are stored too**, so getProposal and the audit log show what was
  asked and why it was refused. A refused out-of-scope proposal cites no evidence and no versions.

## 2026-10-14 — Fixtures for R04, R05, R06, R14

- `refund-ambiguous` (two orders, request names neither), `refund-ineligible` (window closed),
  `refund-injection` (notes ask for another account, another customer's order, self-approval, and the
  API key), and `refund-completed` (already fully refunded). The fixture schema gains an optional
  `suggestedGoal` for the demo. Goals stay untrusted text.

## 2026-10-13 — Approvals wait for an assigned approver

- **Decision (owner):** when a refund needs approval, the task waits for an operator holding the
  approver role instead of being refused because nobody holds it right now. If no approver acts within
  `APPROVAL_TTL_MS` (default 7 days), the approval expires.
- **Gate:** the `APPROVAL_PATH` rule and `GateState.approvalPathAvailable` are removed. Above the
  threshold the gate always returns HUMAN_APPROVAL. Roles are re-read from configuration on every call
  (`contextForCall`), so an approver assigned during the wait can act. The approval itself must still
  come from explicit operator input with the required role.
- **Expiry is not denial:** an expired approval gets status `expired`, and the task ends `partial` with
  an explicit reason ("approval not received within 7 days"), never `refused` or `completed`. Expiry is
  evaluated lazily against the stored `expiresAt` and the injected clock, so no timer has to run for a
  week. Implemented in Steps 5–6. Spec §Reliability and limits ("expired waiting tasks become partial
  or failed with an explicit reason").
- **Deviation from spec defaults:** the spec defaults approvals to 5 minutes and pending tasks to 24 hours
  ("approvals sooner"). Here `APPROVAL_TTL_MS` defaults to 7 days, `PENDING_TASK_TTL_MS` (24 hours) now
  governs only clarification waits, and the config check "approval TTL must not exceed pending TTL" was
  removed. The risk of a long wait is a stale approval. It is contained because the approval binds to
  record versions through `actionDigest`, and because the gate re-runs inside the commit transaction:
  if the refund window closes or the balance changes during the wait, the old approval cannot be used.
- **Waiting costs nothing:** a waiting task holds no worker slot and does not consume the active
  execution clock. Spec Step 6.
- **Retention:** `RETENTION_DAYS` counts from when a task reaches a terminal status, so a task cannot be
  purged while it waits for approval.

## 2026-10-13 — Version 1 is USD-only

- **Decision:** version 1 supports refunds in USD only. The policy configures a threshold only for USD,
  and the gate REFUSEs any order in a currency the policy does not configure, under the new rule
  `SUPPORTED_CURRENCY` in the prohibition phase. This replaces the earlier behavior of sending
  unconfigured currencies to HUMAN_APPROVAL.
- **Why not peg other currencies to 5000 USD:** a USD-equivalent threshold is an inferred conversion,
  which the spec forbids ("do not infer conversions"; other currencies need "explicit configured
  thresholds"). Live exchange rates would make the gate depend on the network and on time, so it would
  no longer be deterministic, and they would add network calls to tests. Fixed per-currency figures would
  be configuration that drifts from any USD benchmark, and currencies differ in minor-unit exponents
  (JPY 0, KWD 3). Every scenario is USD, so none of this would earn its cost.
- **Extensible later:** `RefundPolicy.currencies` stays a map. Adding a currency means a new policy
  version with an explicit threshold for it, with no code change and no conversion. The application
  wiring (Step 7) should also check at startup that `CURRENCY` is configured in the loaded policy.
  Spec §Policy rules, §Version 1 scope.

## 2026-10-13 — Step 4 deterministic gate

- **Signature:** `evaluateAction(context, action, state, policy)` is a pure function with no I/O. The
  application reads `GateState` (order, payment, this task's prior operations on the order, synthetic
  now, approval-path availability) from trusted records. The strict `gateAction` schema has no field for
  a rationale, confidence, preconditions, a decision, or a destination. Spec Step 4.
- **Rule order:** (1) `ORDER_SCOPE`; (2) prohibitions on known facts: `POSITIVE_AMOUNT`,
  `ORDER_CURRENCY`, `DUPLICATE_OPERATION` (already done), `ELIGIBLE_ORDER` (ineligible),
  `AVAILABLE_BALANCE`; (3) unresolved facts: `ORIGINAL_DESTINATION` (no payment record),
  `ELIGIBLE_ORDER` (unknown), `DUPLICATE_OPERATION` (unknown prior outcome), `FRESH_STATE`;
  (4) `APPROVAL_THRESHOLD`; then allowed. Every failing rule in the deciding phase is reported.
  `ORDER_CURRENCY` and `SUPPORTED_CURRENCY` extend the spec's "such as" list. (`APPROVAL_PATH` was
  removed; see "Approvals wait for an assigned approver".)
- **Scope refusal reveals nothing:** unknown orders, out-of-scope orders, and arguments naming a
  different order all produce the identical REFUSE result, with no preconditions or versions. Spec
  §Security and privacy.
- **Unconfigured currency:** ~~a currency absent from the policy needs HUMAN_APPROVAL~~. Superseded by
  "Version 1 is USD-only" below: such a currency is now refused.
- **No approval path (superseded by "Approvals wait for an assigned approver"):** when approval is required but `approvalPathAvailable` is false (no trusted
  operator holds the approver role), the decision is REFUSE under `APPROVAL_PATH`. The explanation names
  the permitted alternative: a refund within the automatic threshold. Spec §Policy rules ("approval is
  offered only when the application has a trusted authorized approval path"), §Product behavior.
- **Preconditions describe knowledge, not outcomes:** a precondition is `satisfied` when the fact is
  established from records, whether it passes or fails. A known disqualifying fact is reported as a rule
  failure (REFUSE), not as a missing precondition. This keeps gate output valid against the
  ActionProposal contract for all four decisions.
- **Duplicates are per task and order:** a committed or verified refund (or note) by the same task on the
  same order refuses another. An attempt with an unknown outcome requires reconciliation first (R14,
  R08). Refunds by other tasks are bounded by `AVAILABLE_BALANCE`.
- **Digest scope:** `actionDigest` covers tool, arguments, target, `{ownerId, scope}` as the caller
  scope, policy version, and state versions. The actor is excluded, so a different trusted operator can
  approve the same action. Canonical JSON sorts keys, keeps array order, and rejects `undefined`, NaN,
  BigInt, and non-plain objects.

## 2026-10-13 — Step 3 storage and synthetic execution model

- **SQLite setup:** `node:sqlite` with STRICT tables, foreign keys on, and WAL for file databases.
  Migrations are append-only, numbered, and recorded in `schema_migrations`, and each runs in its own
  transaction. The database file is `chmod 0600` on open. That is best effort: on Windows chmod only
  toggles the read-only bit, so restrictive permissions there depend on the user profile's ACLs. Spec
  §Security and privacy.
- **Transactions:** `BEGIN IMMEDIATE` takes the write lock before any check runs. SQLite's busy timeout
  (default 1000 ms) plus up to 3 extra attempts bound the contention. If the lock is never obtained, a
  retryable `TIMEOUT` is raised with nothing written. Transaction bodies are synchronous, so no other
  JavaScript runs between a check and its write. Spec Step 3.
- **Isolation:** every storefront table is keyed by `instance_id`, and each task normally gets its own
  instance. `tasks.instance_id` is deliberately not UNIQUE, because concurrency tests share an instance.
- **Synthetic clock:** an instance stores the fixture's `syntheticNow` and its real creation time. Its
  clock is `base.now() + (syntheticStart - createdAt)`, so fixture dates stay meaningful while time still
  advances with the injected clock.
- **Defense in depth on the ledger:**
  - The commit derives amount, order, and expected versions from the immutable proposal. The caller
    passes only the proposal ID.
  - The idempotency key is `refund:<proposalId>`, and `operations` is UNIQUE on both
    `(instance_id, idempotency_key)` and `proposal_id`.
  - The payment update is conditional on the bound version, and the code asserts that exactly one row
    changed.
  - A CHECK constraint keeps `refunded_minor <= paid_minor` even against raw SQL.
  - Proposals are immutable through UPDATE/DELETE triggers.
  - There is one approval per proposal (UNIQUE), so a denial blocks that proposal.
- **Required recheck hook:** `commitRefund` requires a `recheck` callback that runs inside the
  transaction. Step 3 tests pass a no-op explicitly, and Step 5 passes the gate re-evaluation. No caller
  can commit without choosing a recheck. Spec §Policy rules, Step 5.
- **Ledger errors:** a version mismatch is a retryable `STATE_CONFLICT` (re-read, then form a new
  proposal). An over-refund, a currency mismatch, or missing records is a non-retryable
  `STATE_CONFLICT`. Rejected commits roll back, so their `blocked` audit event is written afterwards
  in its own transaction.
- **Verification:** `payments.fixture_refunded_minor` records refunds that predate the scenario.
  `verifyRefund` marks an operation `verified` only when `refunded_minor` equals that baseline plus the
  sum of the order's refund operations.
- **Reconciliation rule:** after any commit error other than `STATE_CONFLICT`, the caller looks up the
  operation by proposal (`findRefundOperation`) before retrying. Even a blind retry returns the existing
  operation (`replayed: true`).
- **Fault controls:** `FaultInjector` is a constructor option of `Storefront`. It offers lookup delay, a
  one-shot state change before commit, a one-shot failure before COMMIT, and a one-shot lost
  acknowledgment after COMMIT. Only tests and the evaluation harness construct it, and no tool or
  service input reaches it.
- **Fixture schema** lives in `src/contracts/scenario.ts`, so storage does not depend on the simulator.
  A fixture's `scope` is trusted operator data, and its record `notes` are untrusted content. Fixture
  validation requires every reference to resolve.
- **Deferred to later steps:** the tables for questions, evidence, approvals, request keys, and
  resolution notes exist now. Their repositories arrive with the steps that use them (5–6), and so does
  the `record_resolution` write.

## 2026-10-13 — Step 2 clock, policy, and eligibility

- **Clock:** `Clock.now()` returns epoch milliseconds. `systemClock` is used in production, and
  `ManualClock` (forward-only `advance`) is used in tests and demos. Eligibility takes `now` explicitly, so
  it is a pure function. Spec Step 2.
- **Policy file:** `policies/refund-policy.v1.json` holds `version`, `approverRole`, and a per-currency
  `autoExecuteMaxMinor` (USD 5000). A currency absent from the map has no threshold and never
  auto-executes, and no conversion is inferred. An unreadable or invalid policy stops startup with
  `ConfigError`. The loader lives in `src/storage` so the domain stays free of file I/O. Spec §Policy
  rules.
- **Window and exclusions are facts, not policy:** spec Step 2 makes the refund window and the
  exclusions fixture-configured. Each order therefore carries `refundWindow {startsAt, days}` and
  `exclusions` as facts, and the fixture decides what event starts the window. The window includes its
  final millisecond.
- **Eligibility result:** each of the four checks (`order_paid`, `within_refund_window`, `no_exclusion`,
  `positive_refundable_balance`) reports `pass`, `fail`, `missing`, or `conflicting`. Any `fail` makes the
  order `ineligible`, even if other facts are unknown. Otherwise any `missing` or `conflicting` check
  makes it `unknown`, which the gate maps to VERIFY_FIRST. Refunds exceeding the payment, a currency
  disagreement between records, and a window that starts in the future count as conflicting. A fully
  refunded order is ineligible, which supports R14.
- **Fact seeding is split across steps:** Step 2 defines the `EligibilityFacts` shape and tests it with
  in-memory facts. Step 3 seeds fixture records into SQLite in that shape, so Step 2 does not depend on
  storage.
- **Step 2 exit criterion:** the contracts and checks that reject malformed input and out-of-scope
  records exist and are unit-tested. The "before model calls or writes" ordering is proven end to end
  once the services and coordinator exist (Steps 5–7).

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

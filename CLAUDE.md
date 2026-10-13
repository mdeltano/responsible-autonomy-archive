# Responsible Autonomy (Project Sundance)

Local TypeScript application: a tool-using customer-service agent for one synthetic workflow, which is
investigating and resolving a refund request. A model *proposes* actions. Deterministic code decides each
one (AUTO_EXECUTE / VERIFY_FIRST / HUMAN_APPROVAL / REFUSE), executes only what passes the gate, and
verifies the ledger. This is a portfolio project. It never claims production readiness or universal safety.
There is **no MCP server or protocol adapter**. The interface is a local CLI, and a web UI is optional later.

## Source of truth

- [docs/SPEC.md](docs/SPEC.md) is the v2.0 requirements and implementation guide. MUST/SHOULD/MAY are
  binding. Work through its **Ordered implementation plan** (Steps 1–10) in order, using each step's exit
  criterion. Cite sections by heading (e.g. "spec §Policy rules", "spec Step 4") in comments and commits.
- [docs/DECISIONS.md](docs/DECISIONS.md) holds tooling choices and deliberate deviations. Never deviate
  silently; add an entry.
- [docs/STATUS.md](docs/STATUS.md) tracks steps, milestones, and acceptance tests R01–R16. Update it when
  any of them changes state.

## Commands

```
npm run build             # tsc -p tsconfig.build.json -> dist/
npm run typecheck         # tsc over src + tests (no emit)
npm test                  # vitest run (all tests, offline)
npm run test:integration  # integration tests only
npm run demo              # local CLI demo (fake planner)
npm run evaluate          # paired evaluation (requires EVALUATION_ENABLED=true)
```

## Stack (pinned exactly in package.json / lockfile)

Node >= 22.13 (dev on 25), ESM, TypeScript 7 (native `tsc`), zod 4 (runtime schemas; use
`z.toJSONSchema` for JSON Schema export), built-in `node:sqlite` (no native addon), vitest, tsx. Install
new deps with `--save-exact`.

## Layout (spec Step 1)

`src/contracts` schemas, domain types, errors · `src/domain` money, policy decisions, proposals,
approvals, task transitions · `src/storage` migrations, repositories, transactions, access checks ·
`src/simulator` synthetic storefront + test-harness fault injection · `src/agent` planner interface,
coordinator, evidence · `src/providers` fake planner + real provider adapters · `src/application`
transport-independent services (startTask, getTask, …) · `src/cli` thin local interface ·
`src/evaluation` runner, graders, metrics, reports · `policies/` versioned refund policy ·
`fixtures/public` model-visible scenarios · `fixtures/expected` hidden oracle outcomes (only the
evaluation grader may read these) · `tests/{unit,integration}`.

Dependencies point inward: `cli` → `application` → `agent`/`domain`/`storage`. Domain and engine code
must not import from `src/cli`. Business rules live in services and the domain, never in the interface.

## Non-negotiable rules

- **Validate everything at runtime.** Inputs are strict objects (reject unknown keys). Planner output is a
  strict discriminated union (tool_call / ask_question / propose_resolution / finish) and stays
  untrusted until it passes schema and reference checks. TypeScript types alone are not validation.
- **Model proposes, code disposes.** The gate computes decisions from facts and policy, never from
  model-authored precondition statuses or confidence. Deterministic code owns IDs, permissions, approval
  binding, budgets, state transitions, idempotency, ledger writes, and evaluation accounting.
- **Money is safe-integer minor units.** No floating-point money math. Never infer currency conversions.
- **Commit is atomic and rechecked.** Re-run the gate inside the commit transaction. Check ledger versions
  and remaining balance, insert the operation under the proposal-scoped idempotency key, update the
  ledger, and write the audit event in one transaction. After a lost acknowledgment, look up the existing
  operation instead of repeating the write.
- **Approvals bind to actionDigest**, which is SHA-256 of canonical JSON over tool, args, target, caller
  scope, policy version, and state versions. A pending approval waits for an assigned approver and
  expires after `APPROVAL_TTL_MS` (default 7 days, a recorded deviation from the spec's 5 minutes).
  Expiry is not a denial. Approvals are invalidated by relevant changes. Only explicit operator input through the interface can approve. The planner never gets an
  approval tool.
- **Trusted context is never derived from text.** CallerContext comes from config, not from goals,
  answers, or record notes. All of those are untrusted data that cannot expand scope or override policy.
- **Secrets and labels stay out.** Credentials, raw provider payloads, and `fixtures/expected` content
  never appear in prompts, reports, or logs. Diagnostics go to stderr, and raw content logging is off by
  default.
- **Honest status.** Never report cancelled, timed-out, or budget-exhausted work as `completed`; use
  `partial`/`failed`. Verify the ledger before declaring completion. Unimplemented commands fail rather
  than pretend.
- Errors are typed `{code, message, retryable, taskId}`. Unknown and foreign-owner IDs return the same
  NOT_FOUND.
- Tests use the injectable fake planner and an injectable clock. No test may make a network call.

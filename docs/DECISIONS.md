# Decisions and spec deviations

Record tooling choices the spec leaves open, and any deliberate deviation from [SPEC.md](SPEC.md),
newest first. Each entry: date, decision, spec section affected, reason.

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

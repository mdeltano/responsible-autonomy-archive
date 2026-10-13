# Decisions and spec deviations

Record tooling choices the spec leaves open, and any deliberate deviation from [SPEC.md](SPEC.md),
newest first. Each entry: date, decision, spec section affected, reason.

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

# Responsible Autonomy

Responsible Autonomy is a tool-using customer-service agent. It completes authorized tasks and recognizes
when it needs more evidence, human approval, or refusal. Version 1 implements one workflow on a fully
synthetic storefront: investigating and resolving a refund request. It runs as a local command-line
application.

A language model plans and proposes actions. Ordinary TypeScript then does the rest:

- validates the arguments,
- checks permissions and current state,
- applies a versioned policy,
- binds approvals,
- executes synthetic side effects atomically,
- records an audit trail.

Every proposed action gets one decision:

| Decision | Meaning |
|---|---|
| `AUTO_EXECUTE` | Preconditions are known and policy allows this exact action |
| `VERIFY_FIRST` | Evidence is missing, conflicting, or stale, so the agent looks it up or asks one precise question |
| `HUMAN_APPROVAL` | Facts are sufficient, but policy requires a trusted operator's approval |
| `REFUSE` | The action breaks a non-overridable rule |

This is a portfolio project. It does not handle real payments and is not production-ready. Its
evaluation results are measured on synthetic scenarios only.

> **Status:** Steps 1–7 of 10 are complete. The deterministic engine, approvals, coordinator, and local CLI
> work end to end with an offline fake planner. A real model provider (Step 8) and the paired evaluation
> (Step 9) are not implemented yet. See [docs/STATUS.md](docs/STATUS.md).

## Requirements

- Node.js 22.13 or newer (an active LTS line such as 22 or 24; developed on Node 25)
- npm 10 or newer

No model API key is needed for development or tests. They use a deterministic fake planner.

## Setup

```sh
npm install
npm run build
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | Type-check sources and tests |
| `npm test` | Run all tests (offline, fake planner) |
| `npm run test:integration` | Run integration tests only |
| `npm run demo` | Guided local demo with the offline fake planner |
| `npm run evaluate` | Paired evaluation suite (Step 9; requires `EVALUATION_ENABLED=true`) |

## Configuration

All settings are environment variables. They are validated at startup, and the application exits with a
message naming the bad variable. See [.env.example](.env.example) for every option and its default.

| Variable | Default | Notes |
|---|---|---|
| `MODEL_PROVIDER` | `fake` | Only `fake` is implemented so far |
| `MODEL_ID` | `fake-model` | Recorded in reports |
| `MODEL_API_KEY` | — | Required only for a real provider; never logged |
| `DATABASE_PATH` | `./data/responsible-autonomy.sqlite` | Tasks, synthetic ledger, audit log |
| `MAX_TOKENS_PER_TASK` | — | Positive integer required before a real provider is enabled |
| `EVALUATION_ENABLED` | `false` | Developer-only evaluation |
| `POLICY_PATH` | `./policies/refund-policy.v1.json` | Versioned refund policy |
| `FIXTURES_DIR` | `./fixtures/public` | Synthetic scenarios offered by the demo |
| `CURRENCY` | `USD` | Three-letter uppercase code |
| `LOCAL_OWNER_ID` / `LOCAL_ACTOR_ID` | `local-owner` / `local-operator` | Demo assumption; see below |
| `LOCAL_ROLES` | (none) | Comma-separated, e.g. `refund_approver` |
| `MAX_COST_USD_PER_TASK` | — | Optional |
| `MAX_PLANNING_STEPS` / `MAX_TOOL_CALLS` | `15` / `20` | Per task |
| `MAX_QUESTIONS` / `MAX_PROVIDER_RETRIES` | `3` / `2` | Per task |
| `ACTIVE_TIMEOUT_MS` | `120000` | Active execution only; waiting does not count |
| `PENDING_TASK_TTL_MS` / `APPROVAL_TTL_MS` | 24 h / 7 days | Waiting for an answer / for an approver |
| `MAX_ACTIVE_TASKS` / `MAX_QUEUED_TASKS` | `2` / `10` | Per owner |
| `RETENTION_DAYS` | `7` | |
| `LOG_LEVEL` / `LOG_RAW_CONTENT` | `info` / `false` | Diagnostics go to stderr |

**Demo identity assumption:** the local demo has one configured owner, operator, and role set, and the
application treats that as trusted caller context. This is not production authentication. Approving a
large refund requires `LOCAL_ROLES=refund_approver` and explicit confirmation typed by the operator. The
agent cannot approve its own proposals.

## Local demo

```sh
cp .env.example .env              # optional; the CLI reads .env when present
# set LOCAL_ROLES=refund_approver in .env to be able to approve large refunds
npm run demo
```

The guided demo lists the installed scenarios, submits a goal, and prints each step. Every gate
decision is shown with its exact proposal: action, original destination, decision, rules, record
versions, digest, and the evidence it cites. The demo then asks for an answer or for an approval
decision, and ends with the outcome verified against the ledger. Type `cancel` at a prompt to cancel.
Press Enter to leave a task waiting and pick it up later:

```sh
npx tsx src/cli/main.ts tasks                          # recent tasks
npx tsx src/cli/main.ts show <taskId>                  # status, question or approval, result
npx tsx src/cli/main.ts proposal <taskId> <proposalId> # exact action, evidence, decision, rules
npx tsx src/cli/main.ts audit <taskId>                 # ordered audit events
npx tsx src/cli/main.ts answer <taskId> <questionId> <answer>
npx tsx src/cli/main.ts approve <taskId> <approvalId>  # shows the proposal, asks you to type "approve"
npx tsx src/cli/main.ts deny <taskId> <approvalId>
npx tsx src/cli/main.ts cancel <taskId>
npx tsx src/cli/main.ts resume                         # recover tasks interrupted by a restart
```

After `npm run build`, the same commands are available as `node dist/cli/main.js <command>`.

| Scenario | Shows |
|---|---|
| `refund-small` | Straightforward completion. The order is found by lookup, so no question is needed |
| `refund-large` | The guide's worked example: pause for approval, then commit once and verify |
| `refund-ambiguous` | One precise question when records cannot tell which order is meant |
| `refund-ineligible` | Refusal under the refund window, with a recorded no-refund resolution |
| `refund-completed` | Recognizing that a refund already happened. No further refund is made |
| `refund-injection` | Order notes with injected instructions, which change nothing |

The demo's planner is a deterministic stand-in for a model. Adversarial planners (for example, one
that obeys injected notes, invents approvals, or repeats commits) are exercised in the test suite.
The approval-invalidation demo is reproduced in `tests/integration/approvals.test.ts` (R07), because
it needs a ledger change between approval and commit.

## Privacy

When a real provider is configured, task goals and the relevant synthetic records are sent to it. Use
synthetic data only. Raw prompts and records are not logged by default.

## Documentation

- [docs/SPEC.md](docs/SPEC.md): v2.0 requirements and implementation guide
- [docs/STATUS.md](docs/STATUS.md): step, milestone, and acceptance-test progress
- [docs/DECISIONS.md](docs/DECISIONS.md): stack choices and spec deviations

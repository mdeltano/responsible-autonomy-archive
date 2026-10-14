# Implementation status

Tracks progress against [SPEC.md §Ordered implementation plan](SPEC.md#ordered-implementation-plan),
[§Build milestones](SPEC.md#build-milestones), and [§Acceptance tests](SPEC.md#acceptance-tests).
Status values: `todo`, `in progress`, `done`, `deferred` (with reason).

## Ordered implementation steps

| Step | Milestone | Status | Exit criterion / notes |
|---|---|---|---|
| 1 Repository and development environment | 1 | done | 2026-10-12. Typecheck and tests pass, and invalid config fails with a message naming the variable. No provider call needed. |
| 2 Contracts and trusted task context | 1 | done | 2026-10-13. Strict contracts, typed errors, CallerContext and scope checks, policy file, deterministic eligibility. 96 unit tests. Service-level ordering ("before model calls or writes") is exercised again end to end in Steps 5–7. |
| 3 Storage and synthetic execution model | 1 | done | 2026-10-13. Migrations, isolated scenario instances, two public fixtures, atomic refund commit, verification, fault injection. Integration test commits once, rejects over-refund, and reconciles a lost acknowledgment without repeating it. |
| 4 Deterministic gate | 1 | done | 2026-10-13. `evaluateAction` covers all four decisions with stable rule IDs in a fixed order. Tests show that reasons, notes, confidence, and model-authored preconditions cannot change a verdict. Canonical JSON and `actionDigest` are tested for key order and for changed amount, target, and version. |
| 5 Approvals and atomic execution | 1 | done | 2026-10-14. R03, R07, R08, R09 pass with fake planners. Approvals bind to digest, policy, and record versions, and are checked before commit and again inside the transaction. Unauthorized, expired, stale, and model-fabricated approvals cannot write the ledger (`tests/integration/approvals.test.ts`, `execution.test.ts`). |
| 6 Coordinator with fake planner | 2 | done | 2026-10-14. Scripted and rule-based planners complete, pause and resume for answers and approvals, stop at planning, tool, time, question, and provider-retry limits, repair invalid output once, cancel without duplicate effects, and recover after a restart (`tests/integration/coordinator.test.ts`, `workflow.test.ts`, `services.test.ts`). |
| 7 Local demonstration interface (CLI) | 2 | done | 2026-10-14. Guided `demo` and subcommands. R01 runs the real entry point in a child process. Tests drive the demo through injected operator input: inspect evidence, answer, approve, deny, cancel (`tests/integration/cli.test.ts`). |
| 8 Model provider integration | 3 | todo | A real-model task succeeds and its claim matches the ledger. |
| 9 Evaluation harness | 4 | todo | R16. Report separates completion, forbidden effects, duplicates, sensitivity, interruptions, and cost. |
| 10 Package and verify release | 4 | todo | Clean clone reproduces tests, demos, and evaluations. |

## Acceptance tests

| ID | Case | Status |
|---|---|---|
| R01 | CLI demo starts and completes a synthetic task | done (fake planner) |
| R02 | Eligible small refund executes once, ledger verified | done (fake planner) |
| R03 | Eligible large refund pauses; only trusted approver can approve | done (fake planner) |
| R04 | Missing identity → lookup or precise clarification; no premature write | done (fake planner) |
| R05 | Ineligible or unauthorized refund refused regardless of model | done (fake planner) |
| R06 | Prompt injection in order notes never overrides policy or leaks secrets | done for the engine with a planner that obeys the notes; rerun against a real model in Step 8 |
| R07 | State change after approval invalidates it; proposal regenerated | done (fake planner) |
| R08 | Lost commit acknowledgment reconciled; no duplicate | done (fake planner) |
| R09 | Concurrent refunds cannot over-refund | done (fake planner) |
| R10 | Same request key → same task; altered input conflicts | done |
| R11 | Invalid planner arguments → bounded repair or typed failure; no side effect | done (fake planner) |
| R12 | Cancellation after commit reports committed outcome, stops work | done (fake planner) |
| R13 | Foreign-owner artifact or approval denied; no leak | done |
| R14 | Already completed task → no extra refund or unrelated action | done (fake planner) |
| R15 | Budget exhaustion or restart → truthful partial/failed; no blind repeat writes | done (fake planner; single process per database) |
| R16 | Held-out evaluation: labels hidden; completion and safety reported separately | todo |

## Definition of done

See the checklist in [SPEC.md §Definition of done](SPEC.md#definition-of-done). Not met yet: it needs a real
provider (Step 8), the paired evaluation (Step 9), and release documentation (Step 10). "Done (fake
planner)" above means the deterministic acceptance test passes. The model-driven runs come later.

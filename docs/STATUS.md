# Implementation status

Tracks progress against [SPEC.md §Ordered implementation plan](SPEC.md#ordered-implementation-plan),
[§Build milestones](SPEC.md#build-milestones), and [§Acceptance tests](SPEC.md#acceptance-tests).
Status values: `todo`, `in progress`, `done`, `deferred` (with reason).

## Ordered implementation steps

| Step | Milestone | Status | Exit criterion / notes |
|---|---|---|---|
| 1 Repository and development environment | 1 | done | 2026-10-12. Typecheck and tests pass, and invalid config fails with a message naming the variable. No provider call needed. |
| 2 Contracts and trusted task context | 1 | done | 2026-10-13. Strict contracts, typed errors, CallerContext and scope checks, policy file, deterministic eligibility. 96 unit tests. Service-level ordering ("before model calls or writes") is exercised again end to end in Steps 5–7. |
| 3 Storage and synthetic execution model | 1 | todo | Non-AI integration test: commits once, rejects over-refund, recovers an unknown-ack operation without repeating it. |
| 4 Deterministic gate | 1 | todo | Policy tests cover all four decisions. Prompt text and confidence cannot change a verdict. |
| 5 Approvals and atomic execution | 1 | todo | R03, R07, R08, R09 pass with a fake planner. |
| 6 Coordinator with fake planner | 2 | todo | Scripted planners complete, pause/resume, stop at limits, and cancel without duplicate effects. |
| 7 Local demonstration interface (CLI) | 2 | todo | R01 end to end. |
| 8 Model provider integration | 3 | todo | A real-model task succeeds and its claim matches the ledger. |
| 9 Evaluation harness | 4 | todo | R16. Report separates completion, forbidden effects, duplicates, sensitivity, interruptions, and cost. |
| 10 Package and verify release | 4 | todo | Clean clone reproduces tests, demos, and evaluations. |

## Acceptance tests

| ID | Case | Status |
|---|---|---|
| R01 | CLI demo starts and completes a synthetic task | todo |
| R02 | Eligible small refund executes once, ledger verified | todo |
| R03 | Eligible large refund pauses; only trusted approver can approve | todo |
| R04 | Missing identity → lookup or precise clarification; no premature write | todo |
| R05 | Ineligible or unauthorized refund refused regardless of model | todo |
| R06 | Prompt injection in order notes never overrides policy or leaks secrets | todo |
| R07 | State change after approval invalidates it; proposal regenerated | todo |
| R08 | Lost commit acknowledgment reconciled; no duplicate | todo |
| R09 | Concurrent refunds cannot over-refund | todo |
| R10 | Same request key → same task; altered input conflicts | todo |
| R11 | Invalid planner arguments → bounded repair or typed failure; no side effect | todo |
| R12 | Cancellation after commit reports committed outcome, stops work | todo |
| R13 | Foreign-owner artifact or approval denied; no leak | todo |
| R14 | Already completed task → no extra refund or unrelated action | todo |
| R15 | Budget exhaustion or restart → truthful partial/failed; no blind repeat writes | todo |
| R16 | Held-out evaluation: labels hidden; completion and safety reported separately | todo |

## Definition of done

See the checklist in [SPEC.md §Definition of done](SPEC.md#definition-of-done). None of it is met yet.

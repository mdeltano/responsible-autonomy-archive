import { silentLogger } from "../../src/agent/log.js";
import type { Planner, PlannerFactory } from "../../src/agent/planner.js";
import { createApplication, type ApplicationDeps } from "../../src/application/services.js";
import { loadConfig } from "../../src/config.js";
import { createCallerIdentity } from "../../src/domain/authorization.js";
import { ManualClock } from "../../src/domain/clock.js";
import { RuleBasedPlanner } from "../../src/providers/fake.js";
import { FaultInjector } from "../../src/simulator/faults.js";
import { listAuditEvents } from "../../src/storage/audit.js";
import { openDatabase, type Database } from "../../src/storage/database.js";
import { listTaskOperations } from "../../src/storage/ledger.js";
import { readPaymentForOrder } from "../../src/storage/records.js";
import { loadTask } from "../../src/storage/tasks.js";
import { loadPolicyFile } from "../../src/storage/policy-file.js";
import { fixtures } from "./scenario.js";

export const policy = loadPolicyFile("policies/refund-policy.v1.json");

export interface TestAppOptions {
  planner?: Planner | PlannerFactory;
  env?: Record<string, string>;
  db?: Database;
  clock?: ManualClock;
  faults?: FaultInjector;
  instanceFor?: ApplicationDeps["instanceFor"];
}

// An application over an in-memory database, a manual clock, and a fake planner. The default operator
// holds refund_approver; `viewer` has no roles and `foreign` belongs to a different owner.
export function testApp(options: TestAppOptions = {}) {
  const config = loadConfig({ LOCAL_ROLES: "refund_approver", ...options.env });
  const db = options.db ?? openDatabase(":memory:");
  const clock = options.clock ?? new ManualClock("2026-10-13T15:00:00Z");
  const faults = options.faults ?? new FaultInjector();
  const planner = options.planner ?? new RuleBasedPlanner();
  const plannerFor: PlannerFactory = typeof planner === "function" ? planner : () => planner;
  const app = createApplication({
    db,
    config,
    policy,
    fixtures,
    clock,
    plannerFor,
    faults,
    log: silentLogger,
    ...(options.instanceFor ? { instanceFor: options.instanceFor } : {}),
  });
  const operator = createCallerIdentity(config);
  const viewer = createCallerIdentity(loadConfig({ ...options.env, LOCAL_ROLES: "" }));
  const foreign = createCallerIdentity(loadConfig({ LOCAL_OWNER_ID: "other-owner", LOCAL_ROLES: "refund_approver" }));

  const start = (scenarioId: string, goal = fixtures.get(scenarioId)?.suggestedGoal ?? "Please refund my order.") =>
    app.startTask(operator, { scenarioId, goal });
  const run = async (scenarioId: string, goal?: string) => app.waitForTask(operator, start(scenarioId, goal).id);

  const instanceOf = (taskId: string) => {
    const task = loadTask(db, taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    return task.instanceId;
  };
  const refunded = (taskId: string, orderId: string) => readPaymentForOrder(db, instanceOf(taskId), orderId)?.refundedMinor;
  const operations = (taskId: string) => listTaskOperations(db, taskId);
  const audit = (taskId: string) => listAuditEvents(db, taskId);
  const allOperations = () => Number(db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind = 'refund'").get()?.n);

  return { app, db, clock, config, faults, operator, viewer, foreign, start, run, refunded, operations, audit, allOperations, instanceOf };
}

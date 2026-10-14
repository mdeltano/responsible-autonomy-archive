import { stderrLogger } from "../agent/log.js";
import { createApplication, type Application } from "../application/services.js";
import type { Config } from "../config.js";
import { systemClock } from "../domain/clock.js";
import { RuleBasedPlanner } from "../providers/fake.js";
import { loadFixtureDirectory } from "../simulator/fixture.js";
import { openDatabase, type Database } from "../storage/database.js";
import { loadPolicyFile } from "../storage/policy-file.js";

// Wires the application for the local CLI from validated configuration. Only the offline fake
// planner exists until Step 8, so no provider receives anything.
export function openRuntime(config: Config): { app: Application; db: Database } {
  const db = openDatabase(config.databasePath);
  const planner = new RuleBasedPlanner();
  const app = createApplication({
    db,
    config,
    policy: loadPolicyFile(config.policyPath),
    fixtures: loadFixtureDirectory(config.fixturesDir),
    clock: systemClock,
    plannerFor: () => planner,
    log: stderrLogger(config.logLevel),
  });
  return { app, db };
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioFixture, type ScenarioFixture } from "../contracts/scenario.js";

// Loads every scenario fixture in a directory (fixtures/public for model-visible scenarios). An invalid
// or duplicate fixture stops loading; the application never runs a partially valid scenario.
export function loadFixtureDirectory(dir: string): Map<string, ScenarioFixture> {
  const fixtures = new Map<string, ScenarioFixture>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = scenarioFixture.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new Error(`Invalid fixture ${file}: ${issues}`);
    }
    if (fixtures.has(parsed.data.id)) throw new Error(`Duplicate fixture id ${parsed.data.id} in ${file}`);
    fixtures.set(parsed.data.id, parsed.data);
  }
  return fixtures;
}

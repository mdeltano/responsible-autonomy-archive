#!/usr/bin/env node
import { ConfigError, loadConfig } from "../config.js";
import { ENGINE_VERSION } from "../version.js";

// Local command-line entry point (spec Step 7). Keep this thin: validate arguments, establish trusted
// caller context, call application services, format results. Commands land with Steps 7 and 9.

const COMMANDS: Record<string, string> = {
  demo: "Run the interactive fake-planner demo (Step 7)",
  evaluate: "Run the paired evaluation suite (Step 9)",
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, text]) => `  ${name.padEnd(10)} ${text}`);
  return [`responsible-autonomy v${ENGINE_VERSION}`, "", "Usage: responsible-autonomy <command>", "", ...lines].join("\n");
}

function main(argv: string[]): number {
  const config = loadConfig();
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (!(command in COMMANDS)) {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 2;
  }
  if (command === "evaluate" && !config.evaluationEnabled) {
    console.error("Evaluation is disabled. Set EVALUATION_ENABLED=true to run it.");
    return 1;
  }
  // Honest status: report unimplemented commands as failures rather than pretending to succeed.
  console.error(`'${command}' is not implemented yet. See docs/STATUS.md.`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err: unknown) {
  console.error(err instanceof ConfigError ? err.message : "Fatal startup error");
  process.exitCode = 1;
}

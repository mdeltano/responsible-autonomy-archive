#!/usr/bin/env node
import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "../config.js";
import { createCallerIdentity } from "../domain/authorization.js";
import { runCli } from "./commands.js";
import { runDemo } from "./demo.js";
import { terminalIO } from "./io.js";
import { openRuntime } from "./runtime.js";

// Local command-line entry point (spec Step 7). Loads configuration (from the environment, plus an
// optional .env file), builds the trusted caller identity from it, and hands off to the commands.

async function main(argv: string[]): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const io = terminalIO();
  const { app, db } = openRuntime(config);
  try {
    return await runCli({ app, caller: createCallerIdentity(config), io, evaluationEnabled: config.evaluationEnabled }, argv, runDemo);
  } finally {
    io.close();
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : "Fatal startup error");
    process.exitCode = 1;
  },
);

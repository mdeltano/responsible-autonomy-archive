// Diagnostics (spec §Security and privacy). Default logs carry IDs, codes, timings, and outcomes only;
// callers must not pass goals, answers, record text, prompts, or credentials as fields.

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// JSON lines on stderr, so diagnostics never mix with CLI output on stdout.
export function stderrLogger(threshold: LogLevel): Logger {
  return {
    log(level, message, fields = {}) {
      if (ORDER[level] > ORDER[threshold]) return;
      process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
    },
  };
}

export const silentLogger: Logger = { log() {} };

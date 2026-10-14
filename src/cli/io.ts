import { createInterface } from "node:readline";

// Operator input and output for the CLI (spec Step 7). Injected so tests can script an operator
// without the agent ever becoming one: answers and approvals still come from this explicit channel.

export interface OperatorIO {
  write(text: string): void;
  error(text: string): void;
  // The next line the operator typed, or null when input has ended.
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

// Terminal IO. Lines are buffered as they arrive, so piped input works as well as a live terminal.
export function terminalIO(): OperatorIO {
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  return {
    write: (text) => process.stdout.write(`${text}\n`),
    error: (text) => process.stderr.write(`${text}\n`),
    ask(prompt) {
      process.stdout.write(prompt);
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

// Scripted IO for tests: answers are consumed in order; everything written is captured.
export function scriptedIO(answers: readonly string[]): OperatorIO & { output: string[]; errors: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (text) => output.push(text),
    error: (text) => errors.push(text),
    ask: async (prompt) => {
      output.push(prompt);
      return queue.shift() ?? null;
    },
    close: () => {},
  };
}

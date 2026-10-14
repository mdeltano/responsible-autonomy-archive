import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallerIdentity } from "../../src/contracts/caller-context.js";
import { runCli } from "../../src/cli/commands.js";
import { runDemo } from "../../src/cli/demo.js";
import { scriptedIO } from "../../src/cli/io.js";
import { testApp } from "../helpers/app.js";

// Local demonstration interface (spec Step 7). Operator input is injected, so these tests play the
// operator without the agent ever being one. R01 runs the real entry point in a child process.

function cli(t: ReturnType<typeof testApp>, answers: string[] = [], caller: CallerIdentity = t.operator) {
  const io = scriptedIO(answers);
  return {
    io,
    run: (argv: string[]) => runCli({ app: t.app, caller, io, evaluationEnabled: false }, argv, runDemo),
    text: () => io.output.join("\n"),
  };
}

describe("guided demo", () => {
  it("completes the large-refund worked example with an explicit approval", async () => {
    const t = testApp();
    const c = cli(t, ["refund-large", "", "approve"]);
    expect(await c.run(["demo"])).toBe(0);
    const text = c.text();
    expect(text).toMatch(/Approval required for this exact proposal/);
    expect(text).toMatch(/Refund \$120\.00 \(12000 USD minor units\) on order O-100 to the original payment \(card-ending-4242\)/);
    expect(text).toMatch(/Decision:  HUMAN_APPROVAL   Rules: APPROVAL_THRESHOLD/);
    expect(text).toMatch(/Digest:    [a-f0-9]{64}/);
    expect(text).toMatch(/: completed \(completed\)/);
    expect(text).toMatch(/Verified against ledger: yes/);
  });

  it("asks the question, takes the answer, and finishes", async () => {
    const t = testApp();
    const c = cli(t, ["1", "", "O-302"]);
    expect(await c.run(["demo"])).toBe(0);
    expect(c.text()).toMatch(/Question: Which order is the refund for\?/);
    expect(c.text()).toMatch(/Options: O-301, O-302/);
    expect(c.text()).toMatch(/: completed/);
  });

  it("denies, which ends the task as refused", async () => {
    const t = testApp();
    const c = cli(t, ["refund-large", "", "deny"]);
    expect(await c.run(["demo"])).toBe(0);
    expect(c.text()).toMatch(/: refused/);
    expect(c.text()).toMatch(/denied proposal/);
  });

  it("cancels while waiting", async () => {
    const t = testApp();
    const c = cli(t, ["refund-large", "", "cancel"]);
    expect(await c.run(["demo"])).toBe(0);
    expect(c.text()).toMatch(/: cancelled/);
    expect(c.text()).toMatch(/No refund was made/);
  });

  it("tells an operator without the role why approval fails, and leaves the task waiting", async () => {
    const t = testApp();
    const c = cli(t, ["refund-large", "", "approve"], t.viewer);
    expect(await c.run(["demo"])).toBe(0);
    expect(c.text()).toMatch(/without the refund_approver role/);
    expect(c.text()).toMatch(/Error \[UNAUTHORIZED\]/);
    expect(c.text()).toMatch(/The task stays waiting\. Decide with: responsible-autonomy approve\|deny/);
  });

  it("leaves a task waiting when input ends", async () => {
    const t = testApp();
    const c = cli(t, ["refund-ambiguous", ""]);
    expect(await c.run(["demo"])).toBe(0);
    expect(c.text()).toMatch(/The task stays waiting\. Answer with: responsible-autonomy answer/);
  });
});

describe("subcommands", () => {
  it("start, show, approve with typed confirmation, proposal, and audit", async () => {
    const t = testApp();
    const c = cli(t, ["no", "approve"]);
    expect(await c.run(["start", "refund-large"])).toBe(0);
    const [task] = t.app.listTasks(t.operator);
    const approvalId = task?.approval?.id;
    if (!task || !approvalId) throw new Error("expected a waiting task");
    expect(c.text()).toMatch(new RegExp(`Decide with: responsible-autonomy approve\\|deny ${task.id} ${approvalId}`));

    expect(await c.run(["approve", task.id, approvalId])).toBe(1); // typed "no": aborted
    expect(c.text()).toMatch(/Aborted; nothing was changed/);
    expect(t.app.getTask(t.operator, { taskId: task.id }).status).toBe("waiting_for_approval");

    expect(await c.run(["approve", task.id, approvalId])).toBe(0);
    expect(t.app.getTask(t.operator, { taskId: task.id }).status).toBe("completed");

    expect(await c.run(["show", task.id])).toBe(0);
    expect(await c.run(["proposal", task.id, task.approval?.proposalId ?? ""])).toBe(0);
    expect(await c.run(["audit", task.id, "--limit", "3"])).toBe(0);
    expect(c.text()).toMatch(/More: responsible-autonomy audit .* --cursor s3/);
  });

  it("answers and cancels from the command line", async () => {
    const t = testApp();
    const c = cli(t);
    await c.run(["start", "refund-ambiguous"]);
    const waiting = t.app.listTasks(t.operator)[0];
    expect(await c.run(["answer", waiting?.id ?? "", waiting?.question?.id ?? "", "O-301", "please"])).toBe(0);
    expect(t.app.getTask(t.operator, { taskId: waiting?.id ?? "" }).status).toBe("completed");

    await c.run(["start", "refund-large"]);
    const large = t.app.listTasks(t.operator).find((s) => s.status === "waiting_for_approval");
    expect(await c.run(["cancel", large?.id ?? ""])).toBe(0);
    expect(c.text()).toMatch(/: cancelled/);
  });

  it("maps errors to exit codes without leaking details", async () => {
    const t = testApp();
    const c = cli(t);
    expect(await c.run(["show", "task_unknown"])).toBe(1);
    expect(c.io.errors.at(-1)).toBe("Error [NOT_FOUND]: Resource not found");
    expect(await c.run(["start", "refund-small", "short"])).toBe(1);
    expect(c.io.errors.at(-1)).toMatch(/INVALID_INPUT/);
    expect(await c.run(["bogus"])).toBe(2);
    expect(await c.run(["show"])).toBe(2);
    expect(await c.run(["show", "x", "--nope"])).toBe(2);
    expect(await c.run(["evaluate"])).toBe(1);
  });
});

describe("R01: command-line demo end to end", () => {
  it("starts the real entry point and completes a synthetic task", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-cli-"));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", "demo"], {
      input: "refund-small\n\n",
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATABASE_PATH: join(dir, "demo.sqlite"), LOCAL_ROLES: "", MODEL_API_KEY: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Task task_[0-9a-f-]+: completed/);
    expect(result.stdout).toMatch(/Verified against ledger: yes/);
    expect(result.stderr).toBe("");
  }, 40_000);
});

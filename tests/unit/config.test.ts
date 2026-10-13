import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies spec §Reliability and limits defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      provider: "fake",
      apiKey: null,
      maxTokensPerTask: null,
      evaluationEnabled: false,
      currency: "USD",
      localOwnerId: "local-owner",
      localRoles: [],
      maxPlanningSteps: 15,
      maxToolCalls: 20,
      maxQuestions: 3,
      maxProviderRetries: 2,
      activeTimeoutMs: 120_000,
      pendingTaskTtlMs: 86_400_000,
      approvalTtlMs: 604_800_000,
      maxActiveTasks: 2,
      maxQueuedTasks: 10,
      retentionDays: 7,
      logRawContent: false,
    });
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ MAX_TOKENS_PER_TASK: "", MAX_ACTIVE_TASKS: "", LOCAL_ROLES: "" });
    expect(config.maxActiveTasks).toBe(2);
    expect(config.localRoles).toEqual([]);
  });

  it("parses the local demo role list", () => {
    expect(loadConfig({ LOCAL_ROLES: "refund_approver, agent" }).localRoles).toEqual(["refund_approver", "agent"]);
  });

  it("fails fast on unsupported providers and invalid limits", () => {
    expect(() => loadConfig({ MODEL_PROVIDER: "openai" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_TOKENS_PER_TASK: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_TOOL_CALLS: "1.5" })).toThrow(ConfigError);
    expect(() => loadConfig({ EVALUATION_ENABLED: "maybe" })).toThrow(ConfigError);
    expect(() => loadConfig({ CURRENCY: "usd" })).toThrow(ConfigError);
    expect(() => loadConfig({ LOCAL_ROLES: "Refund Approver" })).toThrow(ConfigError);
  });

  it("names the offending variable in the error message", () => {
    expect(() => loadConfig({ MAX_TOOL_CALLS: "lots" })).toThrow(/MAX_TOOL_CALLS/);
  });

  it("lets approvals wait longer than clarification answers", () => {
    expect(loadConfig({ APPROVAL_TTL_MS: "604800000", PENDING_TASK_TTL_MS: "86400000" }).approvalTtlMs).toBe(604_800_000);
  });

  it("never exposes a credential while the fake provider is selected", () => {
    expect(loadConfig({ MODEL_API_KEY: "sk-test-not-real" }).apiKey).toBeNull();
  });
});

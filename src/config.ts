import { z } from "zod";

// Runtime configuration (spec Step 1, §Reliability and limits, §Security and privacy). Every setting is
// validated at startup; the application refuses to start on missing credentials or unsupported values.

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const positiveInt = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));

const nonNegativeInt = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().default(fallback));

const opaqueId = z.string().min(1).max(128);
const roleName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const envSchema = z.object({
  // Real provider adapters arrive in Step 8; until then only the offline fake planner is accepted.
  MODEL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["fake"]).default("fake")),
  MODEL_ID: z.preprocess(emptyToUndefined, z.string().min(1).default("fake-model")),
  MODEL_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default("./data/responsible-autonomy.sqlite")),
  MAX_TOKENS_PER_TASK: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  EVALUATION_ENABLED: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
  POLICY_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default("./policies/refund-policy.v1.json")),
  CURRENCY: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Z]{3}$/).default("USD")),
  // Local single-owner demo identity (spec §Policy rules, Step 2): a documented demo assumption,
  // not authentication. Never populated from task input.
  LOCAL_OWNER_ID: z.preprocess(emptyToUndefined, opaqueId.default("local-owner")),
  LOCAL_ACTOR_ID: z.preprocess(emptyToUndefined, opaqueId.default("local-operator")),
  LOCAL_ROLES: z.preprocess(
    (value) => (typeof value === "string" ? value.split(",").map((r) => r.trim()).filter(Boolean) : value ?? []),
    z.array(roleName).max(20),
  ),
  MAX_COST_USD_PER_TASK: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  MAX_PLANNING_STEPS: positiveInt(15),
  MAX_TOOL_CALLS: positiveInt(20),
  MAX_QUESTIONS: nonNegativeInt(3),
  MAX_PROVIDER_RETRIES: nonNegativeInt(2),
  ACTIVE_TIMEOUT_MS: positiveInt(120_000),
  PENDING_TASK_TTL_MS: positiveInt(24 * 60 * 60 * 1000),
  APPROVAL_TTL_MS: positiveInt(5 * 60 * 1000),
  MAX_ACTIVE_TASKS: positiveInt(2),
  MAX_QUEUED_TASKS: positiveInt(10),
  RETENTION_DAYS: positiveInt(7),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["error", "warn", "info", "debug"]).default("info")),
  LOG_RAW_CONTENT: z.preprocess(emptyToUndefined, z.stringbool().default(false)),
});

export interface Config {
  provider: "fake";
  modelId: string;
  apiKey: string | null;
  databasePath: string;
  maxTokensPerTask: number | null;
  evaluationEnabled: boolean;
  policyPath: string;
  currency: string;
  localOwnerId: string;
  localActorId: string;
  localRoles: string[];
  maxCostUsdPerTask: number | null;
  maxPlanningSteps: number;
  maxToolCalls: number;
  maxQuestions: number;
  maxProviderRetries: number;
  activeTimeoutMs: number;
  pendingTaskTtlMs: number;
  approvalTtlMs: number;
  maxActiveTasks: number;
  maxQueuedTasks: number;
  retentionDays: number;
  logLevel: "error" | "warn" | "info" | "debug";
  logRawContent: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Name the offending variables, never their values (MODEL_API_KEY must not leak).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  if (e.MODEL_PROVIDER !== "fake") {
    if (!e.MODEL_API_KEY) {
      throw new ConfigError("MODEL_API_KEY is required for a real model provider");
    }
    if (e.MAX_TOKENS_PER_TASK === undefined) {
      throw new ConfigError("MAX_TOKENS_PER_TASK must be a positive integer before provider calls are enabled");
    }
  }

  if (e.APPROVAL_TTL_MS > e.PENDING_TASK_TTL_MS) {
    // Spec §Reliability: approvals expire sooner than pending tasks.
    throw new ConfigError("APPROVAL_TTL_MS must not exceed PENDING_TASK_TTL_MS");
  }

  return {
    provider: e.MODEL_PROVIDER,
    modelId: e.MODEL_ID,
    apiKey: e.MODEL_PROVIDER === "fake" ? null : (e.MODEL_API_KEY ?? null),
    databasePath: e.DATABASE_PATH,
    maxTokensPerTask: e.MAX_TOKENS_PER_TASK ?? null,
    evaluationEnabled: e.EVALUATION_ENABLED,
    policyPath: e.POLICY_PATH,
    currency: e.CURRENCY,
    localOwnerId: e.LOCAL_OWNER_ID,
    localActorId: e.LOCAL_ACTOR_ID,
    localRoles: e.LOCAL_ROLES,
    maxCostUsdPerTask: e.MAX_COST_USD_PER_TASK ?? null,
    maxPlanningSteps: e.MAX_PLANNING_STEPS,
    maxToolCalls: e.MAX_TOOL_CALLS,
    maxQuestions: e.MAX_QUESTIONS,
    maxProviderRetries: e.MAX_PROVIDER_RETRIES,
    activeTimeoutMs: e.ACTIVE_TIMEOUT_MS,
    pendingTaskTtlMs: e.PENDING_TASK_TTL_MS,
    approvalTtlMs: e.APPROVAL_TTL_MS,
    maxActiveTasks: e.MAX_ACTIVE_TASKS,
    maxQueuedTasks: e.MAX_QUEUED_TASKS,
    retentionDays: e.RETENTION_DAYS,
    logLevel: e.LOG_LEVEL,
    logRawContent: e.LOG_RAW_CONTENT,
  };
}

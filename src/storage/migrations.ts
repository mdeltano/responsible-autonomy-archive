// Versioned schema migrations (spec Step 3). Append new migrations; never edit an applied one.
// Every synthetic business table is keyed by scenario instance, so tasks never share state unless a
// test deliberately points them at the same instance. Tables are STRICT so column types are enforced.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE scenario_instances (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  fixture_version INTEGER NOT NULL,
  -- Synthetic clock: fixture time at creation, advancing with the injected clock afterwards.
  synthetic_start TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  -- One instance per task in normal use; not UNIQUE because concurrency tests share an instance.
  instance_id TEXT NOT NULL REFERENCES scenario_instances (id),
  scenario_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_information',
    'waiting_for_approval', 'completed', 'refused', 'partial', 'failed', 'cancelled')),
  stage TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  budgets_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX tasks_owner ON tasks (owner_id);

CREATE TABLE request_keys (
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, request_key)
) STRICT;

CREATE TABLE customers (
  instance_id TEXT NOT NULL REFERENCES scenario_instances (id),
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (instance_id, id)
) STRICT;

-- Nullable eligibility facts represent facts the fixture deliberately leaves unknown.
CREATE TABLE orders (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  payment_status TEXT CHECK (payment_status IN ('paid', 'unpaid', 'voided')),
  refund_window_starts_at TEXT,
  refund_window_days INTEGER CHECK (refund_window_days > 0),
  exclusions_json TEXT,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (instance_id, id),
  FOREIGN KEY (instance_id, customer_id) REFERENCES customers (instance_id, id),
  CHECK ((refund_window_starts_at IS NULL) = (refund_window_days IS NULL))
) STRICT;

-- The CHECK on refunded_minor is a last line of defence: no code path can over-refund a payment.
CREATE TABLE payments (
  instance_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  paid_minor INTEGER NOT NULL CHECK (paid_minor >= 0),
  -- Refunds that predate the scenario; verification reconciles refunded_minor against this plus operations.
  fixture_refunded_minor INTEGER NOT NULL CHECK (fixture_refunded_minor >= 0),
  refunded_minor INTEGER NOT NULL CHECK (refunded_minor >= fixture_refunded_minor AND refunded_minor <= paid_minor),
  version INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (instance_id, id),
  UNIQUE (instance_id, order_id),
  FOREIGN KEY (instance_id, order_id) REFERENCES orders (instance_id, id)
) STRICT;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  tool TEXT NOT NULL CHECK (tool IN ('commit_refund', 'record_resolution')),
  target_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state_versions_json TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('AUTO_EXECUTE', 'VERIFY_FIRST', 'HUMAN_APPROVAL', 'REFUSE')),
  rule_ids_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX proposals_task ON proposals (task_id);
CREATE TRIGGER proposals_immutable_update BEFORE UPDATE ON proposals
  BEGIN SELECT RAISE(ABORT, 'proposals are immutable'); END;
CREATE TRIGGER proposals_immutable_delete BEFORE DELETE ON proposals
  BEGIN SELECT RAISE(ABORT, 'proposals are immutable'); END;

-- One approval per proposal: a denial blocks that proposal, and changes require a new proposal.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  action_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state_versions_json TEXT NOT NULL,
  required_role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'invalidated')),
  approver_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((status IN ('approved', 'denied')) = (approver_id IS NOT NULL))
) STRICT;

-- Idempotency is scoped to the immutable proposal: one operation per proposal, one per key.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES scenario_instances (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'resolution_note')),
  order_id TEXT NOT NULL,
  amount_minor INTEGER CHECK (amount_minor > 0),
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('committed', 'verified')),
  committed_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (instance_id, idempotency_key),
  FOREIGN KEY (instance_id, order_id) REFERENCES orders (instance_id, id),
  CHECK ((kind = 'refund') = (amount_minor IS NOT NULL AND currency IS NOT NULL)),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL))
) STRICT;

CREATE TABLE resolution_notes (
  operation_id TEXT PRIMARY KEY REFERENCES operations (id),
  instance_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (instance_id, order_id) REFERENCES orders (instance_id, id)
) STRICT;

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  missing_precondition_ids_json TEXT NOT NULL,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  CHECK ((answer IS NULL) = (answered_at IS NULL))
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('record', 'user_statement', 'inference')),
  source_id TEXT NOT NULL,
  record_version INTEGER,
  observed_at TEXT NOT NULL,
  statement TEXT NOT NULL,
  supports_precondition_ids_json TEXT NOT NULL,
  CHECK (kind <> 'record' OR record_version IS NOT NULL)
) STRICT;
CREATE INDEX evidence_task ON evidence (task_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('lookup', 'proposal', 'decision', 'question', 'approval',
    'execution', 'verification', 'state_change', 'error')),
  actor_id TEXT NOT NULL,
  proposal_id TEXT REFERENCES proposals (id),
  operation_id TEXT REFERENCES operations (id),
  evidence_ids_json TEXT NOT NULL,
  rule_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success', 'blocked', 'pending', 'failure', 'unknown')),
  UNIQUE (task_id, sequence)
) STRICT;
`,
  },
];

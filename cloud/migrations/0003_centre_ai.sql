CREATE TABLE IF NOT EXISTS centre_ai_runs (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  error_code TEXT,
  result_text TEXT,
  assistant_message_id TEXT NOT NULL,
  assistant_mutation_id TEXT NOT NULL,
  request_context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_day TEXT NOT NULL,
  lease_expires_at_ms INTEGER,
  lease_token TEXT,
  PRIMARY KEY (workspace_id, run_id)
);

CREATE INDEX IF NOT EXISTS centre_ai_runs_workspace_day
  ON centre_ai_runs (workspace_id, request_day);

CREATE INDEX IF NOT EXISTS centre_ai_runs_global_day
  ON centre_ai_runs (request_day);

CREATE INDEX IF NOT EXISTS centre_ai_runs_active_lease
  ON centre_ai_runs (status, lease_expires_at_ms);

CREATE INDEX IF NOT EXISTS centre_ai_runs_workspace_active ON centre_ai_runs(workspace_id,status,lease_expires_at_ms);

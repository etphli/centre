-- Apply alongside the core migrations. All connector state is workspace scoped.
CREATE TABLE IF NOT EXISTS centre_organato_connections (
  workspace_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_version TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message TEXT
);
CREATE TABLE IF NOT EXISTS centre_organato_operations (
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','unknown','succeeded','conflict','failed')),
  receipt_json TEXT NOT NULL,
  remote_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);
-- An uncertain external write holds the session lock until explicit reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS centre_organato_unresolved_session
  ON centre_organato_operations(workspace_id,event_id)
  WHERE status IN ('pending','unknown');
CREATE TABLE IF NOT EXISTS centre_organato_links (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  organato_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,event_id),
  UNIQUE (workspace_id,connection_id,organato_id)
);

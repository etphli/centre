-- Grade requests retain their result and exact commit payload for safe write replay.
CREATE TABLE IF NOT EXISTS centre_ai_grade_runs (
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 source_draft_id TEXT NOT NULL,
 request_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('processing','prepared','completed','failed','conflict','interrupted')),
 created_at TEXT NOT NULL,
 lease_expires_at TEXT NOT NULL,
 grade_json TEXT,
 provider_json TEXT,
 mutations_json TEXT,
 error_code TEXT,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,source_draft_id)
);
CREATE INDEX IF NOT EXISTS centre_ai_grade_status ON centre_ai_grade_runs(workspace_id,status);
-- Grade-only quotas. Chat has its own durable admission budget.
CREATE TABLE IF NOT EXISTS centre_ai_grade_admissions (
 workspace_id TEXT NOT NULL,
 id TEXT NOT NULL,
 kind TEXT NOT NULL,
 day TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id,kind)
);
CREATE INDEX IF NOT EXISTS centre_ai_grade_admissions_day ON centre_ai_grade_admissions(day,workspace_id,active);

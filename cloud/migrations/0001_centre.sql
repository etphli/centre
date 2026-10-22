-- Centre-owned database only. Never bind an Organato database.
CREATE TABLE centre_device (id TEXT PRIMARY KEY,workspace TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX centre_device_workspace ON centre_device(workspace);
CREATE TABLE centre_pairing (code_hash TEXT PRIMARY KEY,workspace TEXT NOT NULL,expires_at TEXT NOT NULL,issuer_device TEXT NOT NULL);
CREATE TABLE centre_daily(day TEXT NOT NULL,key TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,key));
CREATE TABLE centre_rate (key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
CREATE INDEX centre_rate_window ON centre_rate(window);
CREATE TABLE centre_record (workspace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,cursor INTEGER NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL,data TEXT,PRIMARY KEY(workspace,kind,id));
CREATE INDEX centre_changes ON centre_record(workspace,cursor);
CREATE UNIQUE INDEX centre_study_goal_week ON centre_record(workspace,json_extract(data,'$.weekStart'),json_extract(data,'$.timeZone')) WHERE kind='studyGoal' AND deleted=0;
CREATE INDEX centre_message_history ON centre_record(workspace,json_extract(data,'$.chatId'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE kind='message' AND deleted=0;
CREATE UNIQUE INDEX centre_practice_draft ON centre_record(workspace,json_extract(data,'$.sourceDraftId')) WHERE kind='practice.attempt' AND json_extract(data,'$.sourceDraftId') IS NOT NULL;
CREATE TABLE centre_workspace_usage(workspace TEXT PRIMARY KEY,records INTEGER NOT NULL,receipt_count INTEGER NOT NULL DEFAULT 0,attachment_count INTEGER NOT NULL DEFAULT 0,attachment_bytes INTEGER NOT NULL DEFAULT 0,receipt_bytes INTEGER NOT NULL,record_bytes INTEGER NOT NULL);
CREATE UNIQUE INDEX centre_learning_concept ON centre_record(workspace,COALESCE(json_extract(data,'$.subjectId'),''),COALESCE(json_extract(data,'$.topicId'),''),json_extract(data,'$.conceptKey')) WHERE kind='practice.learningNeed' AND deleted=0 AND json_extract(data,'$.deletedAt') IS NULL;
CREATE TABLE centre_mutation (seq INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,mutation_id TEXT NOT NULL,body_hash TEXT NOT NULL,parent_mutation_id TEXT,kind TEXT NOT NULL,id TEXT NOT NULL,expected_version INTEGER NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL,data TEXT,UNIQUE(workspace,mutation_id));
CREATE INDEX centre_mutation_entity ON centre_mutation(workspace,kind,id,seq);
CREATE TRIGGER centre_mutation_guard BEFORE INSERT ON centre_mutation BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_mutation WHERE workspace=NEW.workspace AND mutation_id=NEW.mutation_id AND body_hash!=NEW.body_hash) THEN RAISE(ABORT,'centre_idempotency_mismatch') END ;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_mutation WHERE workspace=NEW.workspace AND mutation_id=NEW.mutation_id) THEN RAISE(IGNORE) END ;
 SELECT CASE WHEN COALESCE((SELECT count FROM centre_daily WHERE day=substr(NEW.updated_at,1,10) AND key='mutations:global'),0)>=1000 OR COALESCE((SELECT count FROM centre_daily WHERE day=substr(NEW.updated_at,1,10) AND key='mutations:'||NEW.workspace),0)>=500 THEN RAISE(ABORT,'centre_daily_quota') END ;
 SELECT CASE WHEN COALESCE((SELECT receipt_bytes FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)+1024>104857600 THEN RAISE(ABORT,'centre_quota') END ;
 SELECT CASE WHEN COALESCE((SELECT record_bytes FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)+COALESCE(length(CAST(NEW.data AS BLOB)),0)-COALESCE((SELECT length(CAST(data AS BLOB)) FROM centre_record WHERE workspace=NEW.workspace AND kind=NEW.kind AND id=NEW.id),0)>104857600 THEN RAISE(ABORT,'centre_quota') END ;
 SELECT CASE WHEN COALESCE((SELECT version FROM centre_record WHERE workspace=NEW.workspace AND kind=NEW.kind AND id=NEW.id),0) != NEW.expected_version THEN RAISE(ABORT,'centre_conflict') END ;
 SELECT CASE WHEN NEW.deleted=0 AND NEW.kind='learnerMemory' AND NOT EXISTS(SELECT 1 FROM centre_record WHERE workspace=NEW.workspace AND kind=NEW.kind AND id=NEW.id AND deleted=0) AND (SELECT count(*) FROM centre_record WHERE workspace=NEW.workspace AND kind='learnerMemory' AND deleted=0)>=50 THEN RAISE(ABORT,'centre_quota') END ;
 SELECT CASE WHEN NEW.expected_version=0 AND NEW.kind='practice.learningNeed' AND (SELECT count(*) FROM centre_record WHERE workspace=NEW.workspace AND kind='practice.learningNeed')>=500 THEN RAISE(ABORT,'centre_quota') END ;
 SELECT CASE WHEN NEW.kind='attachment' AND NEW.deleted=0 AND EXISTS(SELECT 1 FROM centre_record WHERE workspace=NEW.workspace AND kind=NEW.kind AND id=NEW.id AND deleted=1) THEN RAISE(ABORT,'centre_attachment_conflict') END ;
 SELECT CASE WHEN NEW.kind='chat' AND NEW.deleted=1 AND EXISTS(SELECT 1 FROM centre_record WHERE workspace=NEW.workspace AND kind='chat' AND deleted=0 AND json_extract(data,'$.lineage.kind')='branch' AND json_extract(data,'$.lineage.parentChatId')=NEW.id) THEN RAISE(ABORT,'centre_chat_ancestor') END ;
 SELECT CASE WHEN NEW.kind IN ('attempt','practice.attempt') AND NEW.expected_version != 0 THEN RAISE(ABORT,'centre_immutable') END ;
 SELECT CASE WHEN COALESCE((SELECT receipt_count FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)>=100000 THEN RAISE(ABORT,'centre_quota') END ;
 SELECT CASE WHEN NEW.expected_version=0 AND COALESCE((SELECT records FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)>=20000 THEN RAISE(ABORT,'centre_quota') END ;
END ;
CREATE TRIGGER centre_mutation_apply AFTER INSERT ON centre_mutation BEGIN
 INSERT INTO centre_daily(day,key,count) VALUES(substr(NEW.updated_at,1,10),'mutations:global',1) ON CONFLICT(day,key) DO UPDATE SET count=count+1;
 INSERT INTO centre_daily(day,key,count) VALUES(substr(NEW.updated_at,1,10),'mutations:'||NEW.workspace,1) ON CONFLICT(day,key) DO UPDATE SET count=count+1;
 INSERT INTO centre_workspace_usage(workspace,receipt_count,records,receipt_bytes,record_bytes) VALUES(NEW.workspace,1, CASE WHEN NEW.expected_version=0 THEN 1 ELSE 0 END ,COALESCE(length(CAST(NEW.data AS BLOB)),0)+1024,COALESCE(length(CAST(NEW.data AS BLOB)),0)-COALESCE((SELECT length(CAST(data AS BLOB)) FROM centre_record WHERE workspace=NEW.workspace AND kind=NEW.kind AND id=NEW.id),0)) ON CONFLICT(workspace) DO UPDATE SET receipt_count=receipt_count+1,records=records+excluded.records,receipt_bytes=receipt_bytes+excluded.receipt_bytes,record_bytes=record_bytes+excluded.record_bytes;
 INSERT INTO centre_record(workspace,kind,id,version,cursor,updated_at,deleted,data) VALUES(NEW.workspace,NEW.kind,NEW.id,NEW.expected_version+1,NEW.seq,NEW.updated_at,NEW.deleted,NEW.data) ON CONFLICT(workspace,kind,id) DO UPDATE SET version=excluded.version,cursor=excluded.cursor,updated_at=excluded.updated_at,deleted=excluded.deleted,data=excluded.data;
 UPDATE centre_workspace_usage SET attachment_bytes=attachment_bytes-COALESCE((SELECT size FROM centre_attachment WHERE workspace=NEW.workspace AND id=NEW.id),0),attachment_count=attachment_count- CASE WHEN COALESCE((SELECT size FROM centre_attachment WHERE workspace=NEW.workspace AND id=NEW.id),0)>0 THEN 1 ELSE 0 END WHERE workspace=NEW.workspace AND NEW.kind='attachment' AND NEW.deleted=1;
 DELETE FROM centre_chunk WHERE workspace=NEW.workspace AND id=NEW.id AND NEW.kind='attachment' AND NEW.deleted=1;
 UPDATE centre_attachment SET size=0 WHERE workspace=NEW.workspace AND id=NEW.id AND NEW.kind='attachment' AND NEW.deleted=1;
END ;
CREATE TABLE centre_attachment (workspace TEXT NOT NULL,id TEXT NOT NULL,metadata TEXT NOT NULL,owner_chat_id TEXT NOT NULL,size INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace,id));
CREATE TABLE centre_chunk (workspace TEXT NOT NULL,id TEXT NOT NULL,chunk_index INTEGER NOT NULL,data TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(workspace,id,chunk_index));
CREATE TRIGGER centre_attachment_quota BEFORE INSERT ON centre_attachment BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_attachment WHERE workspace=NEW.workspace AND id=NEW.id AND (metadata!=NEW.metadata OR owner_chat_id!=NEW.owner_chat_id)) THEN RAISE(ABORT,'centre_attachment_conflict') END ;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_attachment WHERE workspace=NEW.workspace AND id=NEW.id) THEN RAISE(IGNORE) END ;
 SELECT CASE WHEN COALESCE((SELECT attachment_bytes FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)+NEW.size>104857600 OR COALESCE((SELECT attachment_count FROM centre_workspace_usage WHERE workspace=NEW.workspace),0)>=1000 THEN RAISE(ABORT,'centre_quota') END ;
END ;

CREATE TRIGGER centre_device_quota BEFORE INSERT ON centre_device BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM centre_device WHERE workspace=NEW.workspace)>=100 THEN RAISE(ABORT,'centre_quota') END ;
END ;
CREATE TRIGGER centre_pairing_quota BEFORE INSERT ON centre_pairing BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM centre_pairing WHERE workspace=NEW.workspace)>=60 THEN RAISE(ABORT,'centre_quota') END ;
END ;

CREATE TRIGGER centre_chunk_guard BEFORE INSERT ON centre_chunk BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_chunk WHERE workspace=NEW.workspace AND id=NEW.id AND chunk_index=NEW.chunk_index AND data=NEW.data) THEN RAISE(IGNORE) END ;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM centre_attachment WHERE workspace=NEW.workspace AND id=NEW.id AND complete=0) THEN RAISE(ABORT,'centre_chunk_conflict') END ;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_chunk WHERE workspace=NEW.workspace AND id=NEW.id AND chunk_index=NEW.chunk_index AND data!=NEW.data) THEN RAISE(ABORT,'centre_chunk_conflict') END ;
END ;

CREATE TRIGGER centre_attachment_usage AFTER INSERT ON centre_attachment BEGIN
 INSERT INTO centre_workspace_usage(workspace,records,receipt_bytes,record_bytes,attachment_count,attachment_bytes) VALUES(NEW.workspace,0,0,0,1,NEW.size) ON CONFLICT(workspace) DO UPDATE SET attachment_count=attachment_count+1,attachment_bytes=attachment_bytes+NEW.size;
END ;

CREATE TRIGGER centre_attachment_owner_immutable BEFORE UPDATE OF owner_chat_id ON centre_attachment WHEN NEW.owner_chat_id!=OLD.owner_chat_id BEGIN
 SELECT RAISE(ABORT,'centre_attachment_conflict');
END ;

CREATE TABLE centre_active_chat_guard(workspace TEXT NOT NULL,chat_id TEXT NOT NULL);
CREATE TRIGGER centre_active_chat_required BEFORE INSERT ON centre_active_chat_guard BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM centre_record WHERE workspace=NEW.workspace AND kind='chat' AND id=NEW.chat_id AND deleted=0 AND json_extract(data,'$.deletedAt') IS NULL) THEN RAISE(ABORT,'centre_chat_inactive') END ;
 SELECT RAISE(IGNORE);
END ;

CREATE TABLE centre_review_guard(workspace TEXT NOT NULL,mutation_id TEXT NOT NULL,body_hash TEXT NOT NULL);
CREATE TRIGGER centre_review_replay_guard BEFORE INSERT ON centre_review_guard BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_mutation WHERE workspace=NEW.workspace AND mutation_id=NEW.mutation_id AND body_hash!=NEW.body_hash) THEN RAISE(ABORT,'centre_idempotency_mismatch') END ;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM centre_mutation WHERE workspace=NEW.workspace AND mutation_id=NEW.mutation_id) THEN RAISE(ABORT,'centre_review_replay') END ;
 SELECT RAISE(IGNORE);
END ;

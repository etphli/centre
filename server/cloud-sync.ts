import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { cloudAuthSchema, cloudChangesSchema, cloudMutationSchema, cloudRecordSchema, CLOUD_LIMITS, type CloudMutation, type CloudRecord } from '../shared/cloud';
import { CLOUD_ENTITY_KINDS, cloudAttachmentSchema, parseCloudEntity } from '../shared/cloud-entities';
import type { CloudStatus } from '../shared/cloud-status';
import type { Snapshot } from '../shared/schema';
import { weeklyStudyGoalSchema } from '../shared/study-log';
import { learningNeedSchema } from '../shared/practice';
import { canShareChatAttachment } from '../shared/chat-lineage';
import { Store } from './store';
import type { Credentials } from './credentials';
import { AttachmentStore } from './attachments';
import { HttpError, errorMessage } from './errors';
import { applyStudyRecord, projectStudyData, projectedKinds, recordKey, sameRecord, type ProjectedRecord } from './cloud-projection';

const journalSchema = z.object({
  schemaVersion:z.literal(1),baseUrl:z.string().default(''),workspaceId:z.string().nullable().default(null),deviceId:z.string().nullable().default(null),expiresAt:z.string().nullable().default(null),enabled:z.boolean().default(false),
  cursor:z.string().default('0'),shadow:z.record(z.string(),cloudRecordSchema).default({}),outbox:z.array(cloudMutationSchema).default([]),
  conflicts:z.record(z.string(),cloudRecordSchema).default({}),uploads:z.record(z.string(),z.object({sha256:z.string(),mutationId:z.string().uuid()})).default({}),
  downloads:z.array(z.string().uuid()).default([]),materialized:z.array(z.string()).default([]),lastSyncedAt:z.string().nullable().default(null),error:z.string().nullable().default(null),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type Fetch = (input:string,init?:RequestInit)=>Promise<Response>;
class CloudFailure extends Error {
  constructor(readonly status:number, readonly code:string, message:string, readonly current:CloudRecord|null=null) { super(message); }
}
export function validCloudBase(input: string) {
  const url = new URL(input);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new HttpError(400,'Use a Centre cloud HTTPS address without a path, or localhost HTTP for development.');
  return url.origin;
}

export class CloudSync {
  private writing:Promise<void> = Promise.resolve();
  private running:Promise<CloudStatus>|null = null;
  private constructor(private readonly store:Store,private readonly credentials:Pick<Credentials,'get'|'set'>,private readonly attachments:AttachmentStore,private journal:Journal,private readonly fetcher:Fetch) {}
  static async open(store:Store,credentials:Pick<Credentials,'get'|'set'>,attachments:AttachmentStore,fetcher:Fetch=fetch) {
    let state = journalSchema.parse({schemaVersion:1});
    try { state = journalSchema.parse(JSON.parse(await readFile(join(store.directory,'cloud-sync.json'),'utf8'))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('The cloud sync journal could not be read. Existing study data and sync writes have been preserved.',{cause:error}); }
    store.state.settings.cloudSyncEnabled = state.enabled;
    if (!state.workspaceId) store.state.settings.cloudAccount = null;
    return new CloudSync(store,credentials,attachments,state,fetcher);
  }
  private persist() {
    const content = JSON.stringify(journalSchema.parse(this.journal),null,2);
    const operation = this.writing.then(async () => {
      const temporary = join(this.store.directory,'cloud-sync.json.tmp');
      await writeFile(temporary,content,{mode:0o600});
      await rename(temporary,join(this.store.directory,'cloud-sync.json'));
    });
    this.writing = operation.catch(()=>undefined);
    return operation;
  }
  private async request(path:string,method='GET',body?:unknown,authenticated=true):Promise<unknown> {
    if (!this.journal.baseUrl) throw new HttpError(400,'Add your Centre cloud address first.');
    const token = authenticated ? await this.credentials.get('cloudSession') : '';
    if (authenticated && !token) throw new HttpError(401,'Sign in to Centre cloud first.');
    const response = await this.fetcher(`${validCloudBase(this.journal.baseUrl)}${path}`,{
      method,headers:{...(token ? {Authorization:`Bearer ${token}`} : {}),...(body === undefined ? {} : {'Content-Type':'application/json'})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000),
    });
    const value:unknown = await response.json();
    if (!response.ok) {
      const failure = z.object({error:z.object({code:z.string(),message:z.string()}),current:cloudRecordSchema.nullable().optional()}).safeParse(value);
      throw new CloudFailure(response.status,failure.success ? failure.data.error.code : 'http',failure.success ? failure.data.error.message : `Centre cloud returned ${response.status}.`,failure.success ? failure.data.current ?? null : null);
    }
    return value;
  }
  private local(state:Snapshot=this.store.state) { return new Map(projectStudyData(state,this.journal.shadow).map(row=>[recordKey(row),row])); }
  private desiredLocal(state:Snapshot=this.store.state) {
    const local = this.local(state);
    for (const [key,previous] of Object.entries(this.journal.shadow)) {
      if (projectedKinds.has(previous.kind) && this.journal.materialized.includes(key) && !local.has(key) && !previous.deleted) local.set(key,{kind:previous.kind,id:previous.id,deleted:true,data:null});
    }
    return local;
  }
  private capture() {
    if (!this.journal.enabled) return;
    const local = this.desiredLocal();
    for (const [key,row] of local) {
      if (this.journal.conflicts[key] || this.journal.outbox.some(value=>recordKey(value)===key)) continue;
      if (!sameRecord(row,this.journal.shadow[key])) this.journal.outbox.push({mutationId:randomUUID(),schemaVersion:1,expectedVersion:this.journal.shadow[key]?.version ?? 0,...row});
    }
  }
  async status():Promise<CloudStatus> {
    const token = await this.credentials.get('cloudSession');
    const authenticated = Boolean(token && this.journal.expiresAt && Date.parse(this.journal.expiresAt)>Date.now());
    const pendingKeys = new Set(this.journal.outbox.map(recordKey));
    if (this.journal.enabled) for (const [key,row] of this.desiredLocal()) if (!sameRecord(row,this.journal.shadow[key])) pendingKeys.add(key);
    const pending = pendingKeys.size + Object.keys(this.journal.uploads).length + this.journal.downloads.length;
    const conflicts = Object.entries(this.journal.conflicts).map(([key,remote])=>{
      const mutation = this.journal.outbox.find(value=>recordKey(value)===key);
      const local = this.desiredLocal().get(key);
      const data = local?.data ?? remote.data;
      const label = z.object({title:z.string().optional(),name:z.string().optional(),weekStart:z.string().optional()}).safeParse(data);
      return {kind:mutation?.kind ?? remote.kind,id:mutation?.id ?? remote.id,label:label.success ? (label.data.title ?? label.data.name ?? (label.data.weekStart ? `Study goal for ${label.data.weekStart}` : 'Study item')).slice(0,100) : 'Study item',canKeepLocal:!(remote.kind==='practice.attempt' && mutation && mutation.id!==remote.id)};
    });
    return {baseUrl:this.journal.baseUrl,workspaceId:this.journal.workspaceId,authenticated,enabled:this.journal.enabled,pending,conflicts,lastSyncedAt:this.journal.lastSyncedAt,error:this.journal.error,
      phase:this.running ? 'syncing' : !this.journal.enabled ? 'local' : Object.keys(this.journal.conflicts).length ? 'conflict' : this.journal.error ? pending ? 'pending' : 'error' : pending ? 'pending' : 'ready'};
  }
  async configure(baseUrl:string) {
    if (this.running) throw new HttpError(409,'Wait for sync to finish.');
    const next = validCloudBase(baseUrl);
    if (this.journal.workspaceId && next !== this.journal.baseUrl) throw new HttpError(409,'This local library is bound to its Centre cloud address. Use a separate local library to connect another cloud.');
    this.journal.baseUrl = next; this.journal.error = null; await this.persist(); return this.status();
  }
  async authenticate(idToken:string) {
    if (this.running) throw new HttpError(409,'Wait for sync to finish.');
    const session = cloudAuthSchema.parse(await this.request('/v1/auth/google','POST',{idToken,deviceName:'Centre desktop'},false));
    if (this.journal.workspaceId && this.journal.workspaceId !== session.workspaceId) throw new HttpError(409,'This local library belongs to another Centre cloud account. Its data has not been uploaded. Use that account or a separate local library.');
    await this.credentials.set('cloudSession',session.token);
    // Display claims only after the configured backend has verified this exact token.
    const claims = z.object({email:z.email(),name:z.string().optional()}).safeParse(JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')));
    if (claims.success) await this.store.update(state=>{state.settings.cloudAccount = {email:claims.data.email,name:claims.data.name ?? claims.data.email};});
    this.journal.workspaceId = session.workspaceId; this.journal.deviceId = session.deviceId; this.journal.expiresAt = session.expiresAt; this.journal.error = null;
    await this.persist();
    return this.status();
  }
  async enableImport() {
    if (this.journal.enabled) return this.sync();
    if (!(await this.status()).authenticated) throw new HttpError(401,'Sign in before importing study data.');
    await this.checkWorkspace();
    const directory = join(this.store.directory,'cloud-backups');
    await mkdir(directory,{recursive:true,mode:0o700});
    await this.store.save();
    const backup = {schemaVersion:1,createdAt:new Date().toISOString(),snapshot:JSON.parse(await readFile(join(this.store.directory,'state.json'),'utf8')),sync:this.journal};
    await writeFile(join(directory,`before-import-${Date.now()}-${randomUUID()}.json`),JSON.stringify(backup,null,2),{flag:'wx',mode:0o600});
    this.journal.enabled = true; await this.store.update(state=>{state.settings.cloudSyncEnabled = true;}); this.capture(); await this.persist();
    return this.sync();
  }
  private async checkWorkspace() {
    const remote = z.object({schemaVersion:z.literal(1),workspaceId:z.string(),deviceId:z.string(),kinds:z.array(z.string())}).parse(await this.request('/v1/bootstrap'));
    if (remote.workspaceId !== this.journal.workspaceId || remote.deviceId !== this.journal.deviceId) throw new HttpError(409,'Cloud account changed. Sync stopped before uploading data.');
    return remote;
  }
  sync():Promise<CloudStatus> {
    if (this.running) return this.running;
    if (!this.journal.enabled) return this.status();
    const operation = this.performSync().finally(()=>{this.running=null;});
    this.running = operation;
    return operation.then(()=>this.status());
  }
  private async performSync():Promise<CloudStatus> {
    try {
      this.capture(); await this.persist();
      await this.checkWorkspace();
      await this.pull();
      for (const mutation of [...this.journal.outbox].slice(0,100)) {
        const key = recordKey(mutation);
        if (this.journal.conflicts[key]) continue;
        try {
          const reply = z.object({record:cloudRecordSchema}).parse(await this.request('/v1/records','POST',mutation));
          if (reply.record.kind !== mutation.kind || reply.record.id !== mutation.id) throw new Error('Cloud returned a different record.');
          this.journal.shadow[key] = reply.record;
          if (!this.journal.materialized.includes(key)) this.journal.materialized.push(key);
          this.journal.outbox = this.journal.outbox.filter(value=>value.mutationId !== mutation.mutationId);
          await this.persist();
        } catch (error) {
          if (error instanceof CloudFailure && error.status === 409 && error.current) { this.journal.conflicts[key] = error.current; await this.persist(); }
          else throw error;
        }
      }
      await this.syncAttachments();
      this.capture();
      this.journal.lastSyncedAt = new Date().toISOString(); this.journal.error = null; await this.persist();
    } catch (error) {
      this.journal.error = errorMessage(error); await this.persist();
    }
    return this.status();
  }
  private async pull() {
    let pages = 0;
    while (++pages<=200) {
      const page = cloudChangesSchema.parse(await this.request(`/v1/changes?cursor=${encodeURIComponent(this.journal.cursor)}&limit=100`));
      if (BigInt(page.cursor)<BigInt(this.journal.cursor) || (page.hasMore && BigInt(page.cursor)<=BigInt(this.journal.cursor))) throw new Error('Cloud returned an invalid change cursor.');
      for (const remote of page.records) {
        if (!remote.deleted && CLOUD_ENTITY_KINDS.includes(remote.kind)) parseCloudEntity(remote.kind,remote.data);
        const key = recordKey(remote),previous = this.journal.shadow[key];
        if (previous && previous.version>=remote.version) continue;
        const appliedAt = Date.now();
        const decision = await this.store.atomic<{accepted:boolean;applied:boolean;conflictKey:string|null}>(current=>{
          // Decide inside the writer queue, then publish journal changes only after persistence.
          if (remote.kind==='studyGoal' && !remote.deleted) {
            const incoming = weeklyStudyGoalSchema.parse(remote.data);
            const localGoal = current.studyLog.goals.find(goal=>goal.id!==incoming.id && !goal.deletedAt && goal.weekStart===incoming.weekStart && goal.timeZone===incoming.timeZone);
            if (localGoal) return {value:{accepted:false,applied:false,conflictKey:recordKey({kind:'studyGoal',id:localGoal.id})},apply:null};
          }
          if (remote.kind==='practice.learningNeed' && !remote.deleted) {
            const incoming = learningNeedSchema.parse(remote.data);
            const localNeed = current.learningNeeds.find(need=>need.id!==incoming.id && !need.deletedAt && need.subjectId===incoming.subjectId && need.topicId===incoming.topicId && need.conceptKey===incoming.conceptKey);
            if (localNeed) return {value:{accepted:false,applied:false,conflictKey:recordKey({kind:remote.kind,id:localNeed.id})},apply:null};
          }
          const local = this.desiredLocal(current).get(key);
          const pending = this.journal.outbox.some(value=>recordKey(value)===key) || (local && !sameRecord(local,previous));
          if (pending && !sameRecord(local,remote)) return {value:{accepted:false,applied:false,conflictKey:key},apply:null};
          const applied = applyStudyRecord(structuredClone(current),remote,appliedAt,this.journal.shadow);
          return {value:{accepted:true,applied,conflictKey:null},apply:applied ? (state:Snapshot)=>{applyStudyRecord(state,remote,appliedAt,this.journal.shadow);} : null};
        });
        if (decision.conflictKey) this.journal.conflicts[decision.conflictKey] = remote;
        const {accepted,applied} = decision;
        if (accepted) {
          if (applied && !this.journal.materialized.includes(key)) this.journal.materialized.push(key);
          this.journal.shadow[key] = remote;
          this.journal.outbox = this.journal.outbox.filter(value=>recordKey(value)!==key);
          if (remote.kind==='attachment') {
            delete this.journal.uploads[remote.id];
            if (remote.deleted) { this.journal.downloads = this.journal.downloads.filter(id=>id!==remote.id); await this.attachments.markDeleted(remote.id); }
            else if (!this.journal.downloads.includes(remote.id)) this.journal.downloads.push(remote.id);
          }
        }
      }
      const deferredAt = Date.now();
      // Messages may precede their chat in another device's outbox.
      const materialized = await this.store.atomic(current=>{
        const rows = Object.values(this.journal.shadow).filter(remote=>{
          const key = recordKey(remote);
          if (remote.kind!=='message' || remote.deleted || this.journal.conflicts[key] || this.journal.materialized.includes(key) || this.journal.outbox.some(value=>recordKey(value)===key)) return false;
          const local = projectStudyData(current,this.journal.shadow).find(value=>recordKey(value)===key);
          return !local && applyStudyRecord(structuredClone(current),remote,deferredAt,this.journal.shadow);
        });
        return {value:rows.map(recordKey),apply:rows.length ? (state:Snapshot)=>{for (const remote of rows) applyStudyRecord(state,remote,deferredAt,this.journal.shadow);} : null};
      });
      for (const key of materialized) if (!this.journal.materialized.includes(key)) this.journal.materialized.push(key);
      this.journal.cursor = page.cursor; await this.persist();
      if (!page.hasMore) return;
    }
    throw new Error('Cloud changes exceeded the per-sync page limit. Sync again to continue.');
  }
  private async syncAttachments() {
    const workspaceId = this.journal.workspaceId;
    if (!workspaceId) return;
    const chats = this.store.state.chats;
    const scoped = chats.map(chat=>({workspaceId,chat}));
    const targets = (id:string) => chats.filter(chat=>!chat.deletedAt && canShareChatAttachment(scoped,id,{workspaceId,chatId:chat.id},{workspaceId,chatId:chat.id}));
    const ids = new Set(chats.flatMap(chat=>chat.messages.flatMap(message=>message.attachmentIds)).filter(id=>targets(id).length>0));
    for (const id of ids) {
      const key = recordKey({kind:'attachment',id});
      if (this.journal.shadow[key]) {
        if (!this.journal.shadow[key].deleted) {
          try { await this.attachments.get(id); }
          catch (error) { if (error instanceof HttpError && error.status===404) { if (!this.journal.downloads.includes(id)) this.journal.downloads.push(id); } else throw error; }
        }
        continue;
      }
      const target = targets(id)[0];
      if (!target) continue;
      let source = target;
      const visited = new Set<string>();
      while (source.lineage.kind==='branch' && !visited.has(source.id)) {
        visited.add(source.id);
        const parent = chats.find(chat=>source.lineage.kind==='branch' && chat.id===source.lineage.parentChatId);
        if (!parent || !canShareChatAttachment(scoped,id,{workspaceId,chatId:parent.id},{workspaceId,chatId:target.id})) break;
        source = parent;
      }
      const {attachment,bytes} = await this.attachments.exportContent(id);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const staged = this.journal.uploads[id] ?? {sha256,mutationId:randomUUID()};
      if (staged.sha256!==sha256) throw new Error('A staged attachment changed on disk. Its upload was preserved for review.');
      this.journal.uploads[id] = staged; await this.persist();
      await this.request(`/v1/attachments/${id}`,'PUT',{name:attachment.name,mimeType:attachment.mimeType,size:attachment.size,sha256,sourceChatId:source.id,chatId:target.id});
      for (let offset=0;offset<bytes.length;offset+=CLOUD_LIMITS.chunkBytes) await this.request(`/v1/attachments/${id}/chunks/${offset/CLOUD_LIMITS.chunkBytes}`,'PUT',{data:bytes.subarray(offset,offset+CLOUD_LIMITS.chunkBytes).toString('base64')});
      const reply = z.object({record:cloudRecordSchema}).parse(await this.request(`/v1/attachments/${id}/complete`,'POST',{mutationId:staged.mutationId}));
      this.journal.shadow[key] = reply.record; delete this.journal.uploads[id]; await this.persist();
    }
    for (const id of [...this.journal.downloads]) {
      const candidates = targets(id);
      if (!candidates.length) { this.journal.downloads = this.journal.downloads.filter(value=>value!==id); await this.persist(); continue; }
      let metadata:z.infer<typeof cloudAttachmentSchema>|null = null;
      let targetChatId:string|null = null;
      for (const target of candidates) {
        try { metadata = cloudAttachmentSchema.parse(await this.request(`/v1/attachments/${id}?chatId=${encodeURIComponent(target.id)}`)); targetChatId = target.id; break; }
        catch (error) { if (!(error instanceof CloudFailure && error.status===404)) throw error; }
      }
      if (!metadata || !targetChatId) throw new Error('No active conversation can read this attachment. Sync its retained history and try again.');
      let existing:Awaited<ReturnType<AttachmentStore['exportContent']>>|null = null;
      try { existing = await this.attachments.exportContent(id); } catch (error) { if (!(error instanceof HttpError && error.status===404)) throw error; }
      if (existing) {
        if (createHash('sha256').update(existing.bytes).digest('hex')!==metadata.sha256) throw new Error('A local attachment conflicts with its cloud digest.');
      } else {
        const chunks:Buffer[] = [];
        for (let index=0;index<Math.ceil(metadata.size/CLOUD_LIMITS.chunkBytes);index++) {
          const chunk = z.object({data:z.string().max(Math.ceil(CLOUD_LIMITS.chunkBytes/3)*4)}).parse(await this.request(`/v1/attachments/${id}/chunks/${index}?chatId=${encodeURIComponent(targetChatId)}`));
          chunks.push(Buffer.from(chunk.data,'base64'));
        }
        const content = Buffer.concat(chunks);
        if (content.length!==metadata.size || createHash('sha256').update(content).digest('hex')!==metadata.sha256) throw new Error('Cloud attachment failed its size or digest check.');
        await this.attachments.upload({name:metadata.name,mimeType:metadata.mimeType,data:content.toString('base64')},id);
      }
      this.journal.downloads = this.journal.downloads.filter(value=>value!==id); await this.persist();
    }
  }
  async pairing() {
    await this.checkWorkspace();
    return {...z.object({code:z.string(),expiresAt:z.string().datetime()}).parse(await this.request('/v1/pairings','POST',{})),baseUrl:this.journal.baseUrl};
  }
  async resolve(kind:string,id:string,choice:'local'|'cloud') {
    if (this.running) throw new HttpError(409,'Wait for sync to finish.');
    const resolvedAt = Date.now();
    const key = recordKey({kind,id}),remote = this.journal.conflicts[key];
    if (!remote) throw new HttpError(404,'Sync conflict not found.');
    const remoteKey = recordKey(remote);
    if (remote.id!==id) {
      const mutation = this.journal.outbox.find(value=>recordKey(value)===key);
      if (kind==='studyGoal' && mutation?.expectedVersion===0) {
        await this.store.update(state=>{
          const local = state.studyLog.goals.find(goal=>goal.id===id);
          state.studyLog.goals = state.studyLog.goals.filter(goal=>goal.id!==id);
          if (choice==='local') {
            const incoming = weeklyStudyGoalSchema.parse(remote.data);
            const desired = weeklyStudyGoalSchema.parse(local);
            const goal = {...desired,id:incoming.id,createdAt:incoming.createdAt,updatedAt:new Date(resolvedAt).toISOString(),revision:Math.max(desired.revision,incoming.revision)+1};
            state.studyLog.goals = [...state.studyLog.goals.filter(value=>value.id!==incoming.id),goal];
          } else applyStudyRecord(state,remote,resolvedAt,this.journal.shadow);
        });
      } else if (kind==='practice.learningNeed' && mutation?.expectedVersion===0) {
        await this.store.update(state=>{
          const local = state.learningNeeds.find(need=>need.id===id);
          state.learningNeeds = state.learningNeeds.filter(need=>need.id!==id);
          if (choice==='local') {
            const incoming = learningNeedSchema.parse(remote.data),desired = learningNeedSchema.parse(local);
            state.learningNeeds = [...state.learningNeeds.filter(need=>need.id!==incoming.id),{...desired,id:incoming.id,createdAt:incoming.createdAt,updatedAt:new Date(resolvedAt).toISOString(),revision:Math.max(incoming.revision,desired.revision)+1}];
          } else applyStudyRecord(state,remote,resolvedAt,this.journal.shadow);
        });
      } else if (kind==='practice.attempt' && choice==='cloud') {
        await this.store.update(state=>{state.attempts = state.attempts.filter(attempt=>attempt.id!==id); applyStudyRecord(state,remote,resolvedAt,this.journal.shadow);});
      } else throw new HttpError(409,'These records have different identities. Use the saved cloud result or review the domain record before retrying.');
    } else if (choice==='cloud') await this.store.update(state=>{applyStudyRecord(state,remote,resolvedAt,this.journal.shadow);});
    this.journal.shadow[remoteKey] = remote;
    if (!this.journal.materialized.includes(remoteKey)) this.journal.materialized.push(remoteKey);
    delete this.journal.conflicts[key];
    this.journal.outbox = this.journal.outbox.filter(value=>recordKey(value)!==key);
    this.capture(); await this.persist(); return this.status();
  }
  async disconnect() {
    if (this.running) throw new HttpError(409,'Wait for sync to finish.');
    this.journal.enabled = false; await this.store.update(state=>{state.settings.cloudSyncEnabled = false; state.settings.cloudAccount = null;}); await this.persist();
    let failure:string|null = null;
    try { if (this.journal.deviceId) await this.request('/v1/devices/revoke','POST',{deviceId:this.journal.deviceId}); }
    catch { failure = 'Disconnected on this device. Cloud session revocation could not be confirmed; revoke it from another signed-in device.'; }
    await this.credentials.set('cloudSession',''); this.journal.expiresAt = null; this.journal.error = failure; await this.persist(); return this.status();
  }
  async close() { await this.running; await this.writing; }
}

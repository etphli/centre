import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calendarEventSchema } from '../shared/schema';
import { handleOrganatoRequest, type Database, type Statement, type OrganatoContext, type Mutation } from './index';

const recordSchema = z.object({ kind:z.string(), id:z.string(), schemaVersion:z.literal(1), version:z.number(), cursor:z.string().regex(/^\d+$/), updatedAt:z.string(), deleted:z.boolean(), data:z.unknown() });
export const object = z.record(z.string(), z.unknown());
export const remoteItemSchema = z.object({
  id:z.string(), version:z.number(), kind:z.enum(['todo','work']), displayName:z.string(),
  subjectId:z.string().nullable(), dueAt:z.string().nullable(), dueDateLocal:z.string().nullable(),
  workingStatus:z.string(), notesMarkdown:z.string(), calendarEnabled:z.boolean(),
  archivedAt:z.string().nullable(), completedAt:z.string().nullable(), estimatedMinutes:z.number().nullable(),
});
export type RemoteItem = z.infer<typeof remoteItemSchema>;
export function remoteItem(overrides: Partial<RemoteItem> = {}): RemoteItem {
  return {id:'imported-todo', version:7, kind:'todo', displayName:'Imported deadline', subjectId:'math',
    dueAt:'2026-10-21T05:00:00Z', dueDateLocal:null, workingStatus:'not_started', notesMarkdown:'Keep these notes',
    calendarEnabled:true, archivedAt:null, completedAt:null, estimatedMinutes:45, ...overrides};
}
export function session() {
  return calendarEventSchema.parse({id:randomUUID(), schemaVersion:1, revision:1, createdAt:'2026-10-21T00:00:00Z',
    updatedAt:'2026-10-21T00:00:00Z', origin:'centre', kind:'session', title:'Revise algebra', date:'2026-10-21',
    time:'16:00', startAt:'2026-10-21T05:00:00Z', timeZone:'Australia/Sydney', plannedDurationMinutes:45,
    notes:'Practice equations', subjectId:'math', completedAt:null});
}

export class LocalD1 implements Database {
  readonly sqlite = new DatabaseSync(':memory:');
  failSQL: ((sql:string) => boolean) | null = null;
  constructor() {
    this.sqlite.exec(readFileSync(new URL('./migrations/0001_organato.sql', import.meta.url), 'utf8'));
    this.sqlite.exec('CREATE TABLE test_entities (workspace TEXT, kind TEXT, id TEXT, record TEXT, PRIMARY KEY(workspace,kind,id))');
  }
  prepare(query:string): Statement {
    let values: (string | number | null)[] = [];
    const execute = () => {
      if (this.failSQL?.(query)) throw new Error('Injected local storage failure');
      return this.sqlite.prepare(query);
    };
    return {
      bind(...input) { values=input; return this; },
      // D1's generic result type is supplied by its caller, as in the production binding.
      async first<T>() { return (execute().get(...values) ?? null) as T | null; },
      async all<T>() { return {results:execute().all(...values) as T[]}; },
      async run() { return execute().run(...values); },
    };
  }
  close() { this.sqlite.close(); }
}

export class Fixture {
  readonly db = new LocalD1();
  token = randomBytes(32).toString('hex');
  readonly keys = {v1:randomBytes(32).toString('base64'),v2:randomBytes(32).toString('base64')};
  readonly calls: {url:string;method:string;body:Record<string,unknown>|null}[] = [];
  readonly items = new Map<string,RemoteItem>();
  readonly writes: Mutation[] = [];
  failPut = false;
  beforeWrite: (() => void) | null = null;
  intercept: ((request:Request) => Promise<Response | null>) | null = null;
  context(workspaceId = 'workspace-a'):OrganatoContext {
    const get = async (kind:string,id:string) => {
      const row = this.db.sqlite.prepare('SELECT record FROM test_entities WHERE workspace=? AND kind=? AND id=?').get(workspaceId,kind,id);
      return row ? recordSchema.parse(JSON.parse(z.string().parse(row.record))) : null;
    };
    const put = async (mutation:Mutation) => {
      this.writes.push(structuredClone(mutation));
      if (this.failPut) throw new Error('Injected entities.put failure');
      const old = await get(mutation.kind,mutation.id);
      if ((old?.version ?? 0) !== mutation.expectedVersion) throw new Error('Cloud CAS conflict');
      const record = recordSchema.parse({...mutation,version:mutation.expectedVersion+1,cursor:String(BigInt(old?.cursor ?? '0')+1n),updatedAt:new Date().toISOString()});
      this.db.sqlite.prepare('INSERT INTO test_entities VALUES (?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET record=excluded.record').run(workspaceId,mutation.kind,mutation.id,JSON.stringify(record));
      return record;
    };
    return {env:{DB:this.db,ORGANATO_ENCRYPTION_KEYS_JSON:JSON.stringify(this.keys),ORGANATO_KEY_VERSION:'v1',ORGANATO_ALLOWED_ORIGINS:'https://organato.test'},
      auth:{workspaceId,deviceId:'test-device'},entities:{get,put,commit:async mutations => {const result=[];for (const mutation of mutations) result.push(await put(mutation));return result;}}};
  }
  async request(path:string,method='GET',payload?:unknown,ctx=this.context()) {
    const response=await handleOrganatoRequest(new Request(`https://centre.test/v1/organato${path}`,{method,...(payload === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}),ctx);
    assert.ok(response);
    return {status:response.status,body:object.parse(await response.json())};
  }
  async connect(ctx=this.context()) {
    const result=await this.request('/connection','POST',{apiKey:this.token,baseUrl:'https://organato.test/api/v1'},ctx);
    assert.equal(result.status,200);
    return result;
  }
  async create(data=session(),operationId=randomUUID(),ctx=this.context()) {
    return {data,operationId,result:await this.request('/sessions','POST',{operationId,id:data.id,data},ctx)};
  }
  readonly fetch:typeof fetch = async (input,init) => {
    const request=new Request(input,init);
    assert.equal(new URL(request.url).origin,'https://organato.test','No fixture request may reach a real service');
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.get('authorization'),`Bearer ${this.token}`);
    const body=request.method === 'GET' ? null : object.parse(await request.clone().json());
    this.calls.push({url:request.url,method:request.method,body});
    if (request.method !== 'GET') this.beforeWrite?.();
    const intercepted=await this.intercept?.(request);
    if (intercepted) return intercepted;
    const path=new URL(request.url).pathname;
    if (path.endsWith('/subjects')) return Response.json({subjects:[{id:'math',displayName:'Mathematics',shortName:'Maths',colour:'#ffffff',active:true}]});
    if (request.method === 'GET' && path.endsWith('/items')) return Response.json({items:[...this.items.values()],nextCursor:null});
    const remoteId=decodeURIComponent(path.split('/')[4] ?? '');
    if (request.method === 'GET') return Response.json({item:this.items.get(remoteId)}, {status:this.items.has(remoteId)?200:404});
    assert.ok(body);
    if (path.endsWith('/items')) {
      assert.equal(request.method,'POST');
      const item=remoteItemSchema.parse({...remoteItem({id:`remote-${this.items.size+1}`,version:1}),...body});
      this.items.set(item.id,item);return Response.json({item}, {status:201});
    }
    const old=this.items.get(remoteId);assert.ok(old);
    if (body.version !== old.version) return Response.json({error:'Version conflict'},{status:409});
    const item=remoteItemSchema.parse({...old,...body,version:old.version+1,
      ...(path.endsWith('/archive') ? {archivedAt:'2026-10-21T05:30:00Z'} : {}),
      ...(body.workingStatus === 'completed' ? {completedAt:'2026-10-21T05:30:00Z'} : body.workingStatus === 'not_started' ? {completedAt:null} : {})});
    this.items.set(item.id,item);return Response.json({item});
  };
  externalWrites() { return this.calls.filter(call => call.method !== 'GET'); }
}

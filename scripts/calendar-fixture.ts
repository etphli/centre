import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';
import { createService } from '../server/index';
import { Store } from '../server/store';
import { createItemSchema, updateItemSchema } from '../server/organato';
import { addCalendarDays, calendarTodayKey } from '../shared/calendar-time';

// Isolated, disposable local service and upstream for exercising the real calendar UI.
const directory = await mkdtemp(join(tmpdir(),'centre-calendar-ui-'));
process.env.ORGANATO_API_KEY = 'org_local_calendar_fixture';
process.env.CENTRE_CODEX_BIN = '/centre-fixture/no-codex';
const today = calendarTodayKey('Australia/Sydney');
type FixtureItem = z.infer<typeof createItemSchema> & {id:string;version:number;workingStatus:string;completedAt:string|null;archivedAt:string|null};
const records = new Map<string,FixtureItem>();
for (const [id,title,subjectId,days] of [['essay','History essay','history',0],['problem-set','Algebra problem set','math',1]] satisfies [string,string,string,number][]) {
  records.set(id,{id,kind:'work',displayName:title,subjectId,dueAt:null,dueDateLocal:addCalendarDays(today,days),version:1,workingStatus:'not_started',completedAt:null,archivedAt:null});
}
let mode = 'normal';
let nextId = 0;
const upstream = createServer((request,response) => { void (async () => {
  response.setHeader('Content-Type','application/json');
  const path = new URL(request.url ?? '/','http://localhost').pathname;
  if (request.method === 'GET') {
    if (path.endsWith('/subjects')) response.end(JSON.stringify({subjects:[{id:'math',displayName:'Mathematics',shortName:'Maths',colour:'#b2aa8e',active:true},{id:'history',displayName:'History',shortName:'History',colour:'#af9a8a',active:true}]}));
    else response.end(JSON.stringify({items:[...records.values()].filter(item => !item.archivedAt),nextCursor:null}));
    return;
  }
  const chunks:Buffer[] = [];
  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  const raw:unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (path === '/__fixture__/mode') { mode = z.object({mode:z.enum(['normal','conflict','uncertain','failed'])}).parse(raw).mode; response.end(JSON.stringify({mode})); return; }
  if (mode === 'uncertain') { request.socket.destroy(); return; }
  if (mode === 'failed') { response.writeHead(503).end(JSON.stringify({error:'Local fixture failure. The item was not changed.'})); return; }
  if (mode === 'conflict') { response.writeHead(409).end(JSON.stringify({error:'Local fixture version conflict.'})); return; }
  const archive = /^\/api\/v1\/items\/([^/]+)\/archive$/.exec(path);
  if (archive && request.method === 'POST') {
    const input = z.object({version:z.number().int().positive()}).strict().parse(raw);
    const current = records.get(archive[1]);
    if (!current) { response.writeHead(404).end(JSON.stringify({error:'Not found'})); return; }
    if (current.archivedAt || current.version !== input.version) { response.writeHead(409).end(JSON.stringify({error:'Stale version'})); return; }
    const item = {...current,version:current.version+1,archivedAt:new Date().toISOString()};
    records.set(item.id,item); response.end(JSON.stringify({item})); return;
  }
  if (request.method === 'POST' && path === '/api/v1/items') {
    const input = createItemSchema.parse(raw);
    const item = {...input,id:`fixture-session-${++nextId}`,subjectId:input.subjectId ?? null,dueAt:input.dueAt ?? null,dueDateLocal:input.dueDateLocal ?? null,version:1,workingStatus:'not_started',completedAt:null,archivedAt:null};
    records.set(item.id,item); response.writeHead(201).end(JSON.stringify({item})); return;
  }
  const update = /^\/api\/v1\/items\/([^/]+)$/.exec(path);
  if (update && request.method === 'PATCH') {
    const input = updateItemSchema.parse(raw);
    const current = records.get(update[1]);
    if (!current) { response.writeHead(404).end(JSON.stringify({error:'Not found'})); return; }
    if (current.version !== input.version) { response.writeHead(409).end(JSON.stringify({error:'Stale version'})); return; }
    const item = {...current,...input,version:current.version+1,completedAt:input.workingStatus === 'completed' ? new Date().toISOString() : input.workingStatus === 'not_started' ? null : current.completedAt};
    records.set(item.id,item); response.end(JSON.stringify({item})); return;
  }
  response.writeHead(404).end(JSON.stringify({error:'Fixture route not found'}));
})().catch(error => response.writeHead(500).end(JSON.stringify({error:error instanceof Error ? error.message : 'Fixture error'}))); });
await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Fixture did not start.');
const store = await Store.open(directory);
store.state.settings.organatoBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/api/v1`;
await store.save();
const service = await createService({dataDir:directory});
async function seed(path:string,input:unknown) {
  const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
  if (!response.ok) throw new Error(await response.text());
}
await seed('/organato/sync',{});
await seed('/events',{title:'Algebra revision',date:today,time:'15:30',plannedDurationMinutes:90,subjectId:'math',notes:'Quadratics and simultaneous equations.'});
await seed('/events',{title:'Essay outline',date:today,time:'16:00',plannedDurationMinutes:45,subjectId:'history',notes:'Choose evidence for the first two paragraphs.'});
await seed('/events',{title:'Review practice answers',date:addCalendarDays(today,1),time:'17:00',plannedDurationMinutes:60,subjectId:'math'});
const web = await createViteServer({configFile:false,plugins:[react(),{name:'fixture-csp',transformIndexHtml:html => html.replace("script-src 'self'","script-src 'self' 'unsafe-inline'")}],server:{host:'127.0.0.1',port:5286,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${service.port}`,configure:proxy => proxy.on('proxyReq',request => request.setHeader('Authorization',`Bearer ${service.token}`))}}}});
await web.listen();
process.stdout.write(`Calendar fixture ready: http://127.0.0.1:5286\nDisposable data: ${directory}\nUpstream fixture controls: http://127.0.0.1:${upstreamAddress.port}/__fixture__/mode\n`);
const stop = () => { void Promise.all([web.close(),service.close(),new Promise<void>(resolve => upstream.close(() => resolve()))]).then(() => process.exit(0)); };
process.once('SIGINT',stop); process.once('SIGTERM',stop);

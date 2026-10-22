/** Isolated local UI verification. Uses production handlers, SQLite and signed test identities. */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCloudTestHarness } from '../cloud/test-support';
import { Store } from '../server/store';
import { Credentials } from '../server/credentials';
import { AttachmentStore } from '../server/attachments';
import { CloudSync } from '../server/cloud-sync';
import { createService } from '../server/index';
import { chatSchema, resourceSchema } from '../shared/schema';

const fixture = await createCloudTestHarness();
fixture.setTime(Date.now());
let offline = false;
const bridge = createServer((request,response)=>{void (async()=>{
  const path = new URL(request.url ?? '/','http://127.0.0.1').pathname;
  if (path==='/fixture/invalidate-pairings' && request.method==='POST') { fixture.db.sqlite.exec('DELETE FROM centre_pairing'); response.end('Invitations invalidated'); return; }
  if (path==='/fixture/pending' && request.method==='POST') {
    offline=true;
    await fetch(`http://127.0.0.1:${service.port}/api/settings`,{method:'PATCH',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({nickname:'Saved on this computer'})});
    response.end('Local edit saved while offline');return;
  }
  if (path==='/fixture/conflict' && request.method==='POST') {
    offline=false;
    const session=await fixture.login('alice');
    await fixture.call('/v1/fixture-context','GET',undefined,String(session.token));
    const context=fixture.context();
    if (!context) throw new Error('Fixture identity unavailable');
    const current=await context.entities.get('preferences','preferences');
    if (!current?.data) throw new Error('Import first');
    const result=await fixture.call('/v1/records','POST',{mutationId:randomUUID(),kind:'preferences',id:'preferences',schemaVersion:1,expectedVersion:current.version,deleted:false,data:{...current.data,nickname:'Saved on another device'}},String(session.token));
    if(result.status!==200) throw new Error('Fixture remote edit failed');
    response.end('Remote conflicting edit saved');return;
  }
  if (path==='/fixture/offline' && request.method==='POST') { offline = true; response.end('Offline'); return; }
  if (path==='/fixture/online' && request.method==='POST') { offline = false; response.end('Online'); return; }
  if (offline) { response.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:'offline',message:'Local verification service is offline.'}})); return; }
  const chunks:Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (const [key,value] of Object.entries(request.headers)) { if (Array.isArray(value)) for (const item of value) headers.append(key,item); else if (value !== undefined) headers.set(key,value); }
  fixture.setTime(Date.now());
  const result = await fixture.fetch(`${baseUrl}${request.url}`,{method:request.method,headers,...(['GET','HEAD'].includes(request.method ?? 'GET') ? {} : {body:Buffer.concat(chunks).toString()})});
  response.writeHead(result.status,Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
})().catch(error=>{response.writeHead(500).end(String(error));});});
await new Promise<void>(resolve=>bridge.listen(Number(process.env.CENTRE_PREVIEW_CLOUD_PORT ?? 0),'127.0.0.1',resolve));
const bridgeAddress = bridge.address();
if (!bridgeAddress || typeof bridgeAddress==='string') throw new Error('Local fixture could not bind.');
const baseUrl = `http://127.0.0.1:${bridgeAddress.port}`;
const directory = await mkdtemp(join(tmpdir(),'centre-cloud-ui-'));
const store = await Store.open(directory);
const now = new Date().toISOString();
store.state.resources.push(resourceSchema.parse({id:randomUUID(),subjectId:null,topicId:null,title:'Quadratic revision',kind:'notes',createdAt:now,updatedAt:now,content:'Factorise first. Check both roots against the original equation.'}));
store.state.chats.push(chatSchema.parse({id:randomUUID(),title:'Practising quadratics',createdAt:now,updatedAt:now,messages:[]}));
await store.save();
const credentials = new Credentials(directory);
const cloud = await CloudSync.open(store,credentials,new AttachmentStore(directory));
if (process.env.CENTRE_PREVIEW_AUTH !== '0') {
  await cloud.configure(baseUrl);
  await cloud.authenticate(await fixture.identity('alice'));
}
const service = await createService({port:Number(process.env.CENTRE_PREVIEW_SERVICE_PORT ?? 0),dataDir:directory});
await mkdir('.runtime',{recursive:true});
await writeFile(process.env.CENTRE_CONNECTION_FILE ?? '.runtime/connection.json',JSON.stringify({port:service.port,token:service.token}),{mode:0o600});
await writeFile('.runtime/cloud-preview.json',JSON.stringify({directory,servicePort:service.port,cloudPort:bridgeAddress.port}),{mode:0o600});
process.stdout.write(`Local cloud fixture ready. Service ${service.port}, cloud ${bridgeAddress.port}. Set CENTRE_SERVICE_PORT to this service port and run dev:web on a free port. This is local verification, not a deployed integration.\n`);
async function close() { await service.close(); await credentials.set('cloudSession',''); bridge.close(); fixture.db.sqlite.close(); process.exit(0); }
process.once('SIGINT',()=>{void close();});
process.once('SIGTERM',()=>{void close();});

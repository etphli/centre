import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createCloudTestHarness } from '../cloud/test-support';
import { handleCloudExtension } from '../cloud/extensions';
import { serveMobileAsset } from '../cloud/mobile-assets';
import { resourceSchema, calendarEventSchema, memorySchema } from '../shared/schema';
import { manualSession } from '../mobile-web/domain';
// Disposable authenticated SQLite fixture. Google signing and AI responses are simulated;
// browser storage, Worker routing, CAS, grading and persistence are the actual implementations.
const root=resolve(import.meta.dirname,'..'),port=Number(process.env.CENTRE_IPHONE_FIXTURE_PORT??5328);
const fixture=await createCloudTestHarness({extension:handleCloudExtension});
let inferences=0,lostAck=false;
fixture.env.AI={async run(){inferences++;return {response:'A local test reply: break the problem into one small step, then check your understanding.'};}};
const account=await fixture.login('alice'),other=await fixture.login('bob');
const token=String(account.token),stamp=new Date().toISOString(),ids={note:crypto.randomUUID(),quiz:crypto.randomUUID(),checklist:crypto.randomUUID(),review:crypto.randomUUID(),calendar:crypto.randomUUID()};
async function put(kind:string,id:string,data:object,expectedVersion=0){const result=await fixture.call('/v1/records','POST',{mutationId:crypto.randomUUID(),kind,id,schemaVersion:1,expectedVersion,deleted:false,data},token);if(result.status!==200)throw new Error(`Seed ${kind}: ${JSON.stringify(result.value)}`);return result.value;}
await put('resource',ids.note,resourceSchema.parse({id:ids.note,subjectId:null,topicId:null,title:'Forces and motion',kind:'notes',createdAt:stamp,updatedAt:stamp,content:'# Start with the forces\n\nA resultant force changes an object’s motion.\n\n- Draw a free-body diagram.\n- Choose a positive direction.\n- Apply **F = ma**.\n\n## A useful check\nThe units should be newtons.'}));
await put('resource',ids.quiz,resourceSchema.parse({id:ids.quiz,subjectId:null,topicId:null,title:'Check your understanding',kind:'quiz',createdAt:stamp,updatedAt:stamp,content:'',questions:[{id:'q1',concept:'forces',responseType:'multiple_choice',prompt:'A 2 kg object accelerates at 3 m/s². What is the resultant force?',choices:['6 N','1.5 N','5 N'],answer:'6 N',explanation:'F = ma = 2 × 3.',marks:1},{id:'q2',concept:'motion',responseType:'multiple_choice',prompt:'What happens with zero resultant force?',choices:['Velocity stays constant','It must stop'],answer:'Velocity stays constant',explanation:'No resultant force means no acceleration.',marks:1}]}));
await put('resource',ids.checklist,resourceSchema.parse({id:ids.checklist,subjectId:null,topicId:null,title:'Before your physics session',kind:'diagram',createdAt:stamp,updatedAt:stamp,content:'<h2>Set yourself up</h2><label><input type="checkbox" data-centre-checklist-id="materials">Gather your notes</label><label><input type="checkbox" data-centre-checklist-id="practice">Choose three practice questions</label><script>fetch("/_fixture/attack")</script><img src="/_fixture/attack"><p>Take one question at a time.</p>'}));
await put('reviewMemory',ids.review,memorySchema.parse({id:ids.review,subjectId:null,topicId:null,resourceId:ids.quiz,question:'What does a zero resultant force tell you?',note:'It means no acceleration, not necessarily no motion.',createdAt:stamp,nextReviewAt:'2026-10-01T00:00:00.000Z',resolvedAt:null,learningNeedId:null}));
const day=new Date().toISOString().slice(0,10);
await put('calendarEvent',ids.calendar,calendarEventSchema.parse({schemaVersion:1,origin:'centre',id:ids.calendar,revision:1,title:'Physics practice',kind:'session',date:day,time:'17:00',startAt:day+'T17:00:00.000Z',plannedDurationMinutes:45,subjectId:null,notes:'Work through forces and motion.',completedAt:null,createdAt:stamp,updatedAt:stamp,deletedAt:null,timeZone:'UTC'}));
const manual=manualSession({title:'Yesterday’s revision',date:day,time:'00:00',minutes:60,subjectId:null,timeZone:'UTC'},Math.max(Date.now(),Date.parse(day+'T02:00:00Z')));await put('studySession',manual.id,manual);
await put('preferences','preferences',{nickname:'',theme:'dark',density:'compact',textSize:'standard',studentYearLevel:9,timeZone:'Australia/Sydney',responseStyle:'balanced',defaultQuizQuestions:8,defaultTestLengthMode:'time',defaultTestMinutes:45,defaultTestQuestions:10,defaultQuizQuestionTypes:['multiple_choice','short_response','long_response'],defaultTestQuestionTypes:['multiple_choice','short_response','long_response'],defaultDifficulty:'standard'});
let attacks=0;
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
 if(url.pathname==='/_fixture/invitation'){const who=url.searchParams.get('workspace')==='bob'?other:account;const value=await fixture.call('/v1/pairings','POST',{},String(who.token));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value.value));return;}
 if(url.pathname==='/_fixture/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({inferences,attacks,ids,rows:(await fixture.call('/v1/changes?cursor=0&limit=500','GET',undefined,token)).value.records}));return;}
 if(url.pathname==='/_fixture/lose-next-record'){lostAck=true;res.end('ok');return;}
 if(url.pathname==='/_fixture/attack'){attacks++;res.end('canary');return;}
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const body=Buffer.concat(chunks),headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(','):value);
 const request=new Request(url,{method:req.method,headers,...(body.length?{body}:{} )});
 const asset=await serveMobileAsset(request,{async fetch(input){const path=new URL(input.url).pathname;const file=resolve(root,'dist-iphone','.'+(path.endsWith('/')?path+'index.html':path));if(!file.startsWith(resolve(root,'dist-iphone')+'/'))return new Response('Not found',{status:404});try{return new Response(await readFile(file),{headers:{'Content-Type':mime[extname(file)]??'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}}});
 const response=asset??await fixture.worker.fetch(request,fixture.env);
 if(url.pathname==='/v1/records'&&req.method==='POST'&&lostAck){lostAck=false;res.destroy();return;}
 res.statusCode=response.status;response.headers.forEach((value,name)=>res.setHeader(name,value));res.end(Buffer.from(await response.arrayBuffer()));
}catch(error){res.statusCode=500;res.end(error instanceof Error?error.stack:String(error));}});
await new Promise<void>(done=>server.listen(port,'127.0.0.1',done));
await mkdir(resolve(root,'.runtime/iphone-fixture'),{recursive:true});
await writeFile(resolve(root,'.runtime/iphone-fixture/info.json'),JSON.stringify({port,ids}),{mode:0o600});
console.log(`Centre disposable iPhone fixture http://127.0.0.1:${port}/iphone/ (simulated Google and inference; real Worker/SQLite)`);
process.on('SIGTERM',()=>server.close(()=>{fixture.db.sqlite.close();process.exit(0);}));

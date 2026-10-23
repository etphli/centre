import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const directory = resolve(import.meta.dirname, '../dist-iphone/iphone');
async function files(path) {
  const entries = await readdir(path, {withFileTypes:true});
  const groups = await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path,entry.name)) : [resolve(path,entry.name)]));
  return groups.flat().filter(file => !file.endsWith('/sw.js'));
}
const paths = (await files(directory)).sort();
const hash = createHash('sha256');
for (const file of paths) hash.update(await readFile(file));
const version = hash.digest('hex').slice(0,16);
const shell = paths.map(file => '/iphone/' + relative(directory,file));
shell.push('/iphone/');
await writeFile(resolve(directory,'sw.js'), `
const CACHE='centre-iphone-${version}';
const SHELL=${JSON.stringify(shell)};
const ALLOWED=new Set(SHELL);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{credentials:'omit',cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('centre-iphone-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||!ALLOWED.has(url.pathname)||url.search||request.headers.has('Authorization'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate'){
   try{const response=await fetch(request);if(response.ok&&response.headers.get('Content-Type')?.includes('text/html'))return response;}catch{}
   return await cache.match('/iphone/')||Response.error();
  }
  return await cache.match(url.pathname)||fetch(request);
 })());
});
`);
console.log('Built Centre iPhone offline shell '+version+' ('+shell.length+' static paths; APIs excluded)');

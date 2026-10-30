import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { latestPublicRelease,newerRelease } from './public-releases';
test('public update discovery needs no token and picks the matching architecture',async()=>{
  let payload:unknown={tag_name:'v0.1.20',draft:false,prerelease:false,html_url:'https://github.com/etphli/centre/releases/tag/v0.1.20',assets:['arm64','x64'].map(arch=>({name:`Centre-0.1.20-${arch}.dmg`,browser_download_url:`https://github.com/etphli/centre/releases/download/v0.1.20/Centre-0.1.20-${arch}.dmg`}))};
  let code=200;
  const server=createServer((request,response)=>{assert.equal(request.headers.authorization,undefined);response.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(payload));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address && typeof address!=='string');
  const fetcher:typeof fetch=(_input,options)=>fetch(`http://127.0.0.1:${address.port}`,options);
  try {
    for(const arch of ['arm64','x64']) {const value=await latestPublicRelease(arch,fetcher);assert.equal(value.version,'0.1.20');assert.ok(value.downloadUrl?.endsWith(`-${arch}.dmg`));assert.equal(value.automatic,false);}
    code=429;await assert.rejects(()=>latestPublicRelease('arm64',fetcher),/limiting/);
    code=200;payload={tag_name:'v0.1.20',draft:false,prerelease:false,html_url:'https://github.com/etphli/centre/releases/tag/v0.1.20',assets:[{name:'Centre-0.1.20-arm64.dmg',browser_download_url:'https://example.com/install.dmg'}]};
    await assert.rejects(()=>latestPublicRelease('arm64',fetcher),/unexpected Centre installer/);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('release comparison handles local builds and numeric version ordering',()=>{
 assert.equal(newerRelease('0.1.20','0.1.9'),true);assert.equal(newerRelease('0.1.20','0.1.20-local.20261031'),false);assert.equal(newerRelease('0.1.20','0.2.0'),false);assert.equal(newerRelease('0.2.0','0.1.99'),true);
});

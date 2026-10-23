import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveMobileAsset } from './mobile-assets';

test('iPhone assets stay in their public path and never receive API requests',async()=>{
  const paths:string[]=[];
  const assets={fetch:async(request:Request)=>{paths.push(new URL(request.url).pathname);return new Response('<html>Centre</html>',{headers:{'Content-Type':'text/html'}});}};
  assert.equal(await serveMobileAsset(new Request('https://centre.test/v1/changes'),assets),null);
  assert.equal(await serveMobileAsset(new Request('https://centre.test/iphone-not-real'),assets),null);
  const response=await serveMobileAsset(new Request('https://centre.test/iphone/'),assets);
  assert.equal(response?.status,200);
  assert.deepEqual(paths,['/iphone/']);
  assert.equal(response?.headers.get('Service-Worker-Allowed'),'/iphone/');
  assert.match(response?.headers.get('Content-Security-Policy')??'',/script-src 'self';/);
  assert.equal(response?.headers.get('Referrer-Policy'),'no-referrer');
  assert.equal((await serveMobileAsset(new Request('https://centre.test/iphone/',{method:'POST'}),assets))?.status,405);
  assert.equal((await serveMobileAsset(new Request('https://centre.test/iphone/')))?.status,503);
  const redirect=await serveMobileAsset(new Request('https://centre.test/iphone'));
  assert.equal(redirect?.headers.get('Location'),'https://centre.test/iphone/');
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { z } from 'zod';

const run = promisify(execFile);

test('Electron adds macOS trusted roots without replacing defaults or accepting an untrusted TLS peer', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-system-trust-'));
  try {
    const key=join(directory,'key.pem'), cert=join(directory,'cert.pem');
    await run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=localhost','-days','1']);
    const entry=join(directory,'check.cjs');
    await build({stdin:{contents:`
      import assert from 'node:assert/strict';
      import * as tls from 'node:tls';
      import {X509Certificate} from 'node:crypto';
      import {createServer} from 'node:https';
      import {readFile} from 'node:fs/promises';
      import {useSystemCertificateAuthorities} from ${JSON.stringify(resolve('electron/system-trust.ts'))};
      void (async()=>{
        const before=tls.getCACertificates('default'), system=tls.getCACertificates('system');
        useSystemCertificateAuthorities();
        const fingerprint=cert=>new X509Certificate(cert).fingerprint256;
        const after=new Set(tls.getCACertificates('default').map(fingerprint));
        assert.ok(before.every(cert=>after.has(fingerprint(cert))));
        assert.ok(system.every(cert=>after.has(fingerprint(cert))));
        const server=createServer({key:await readFile(${JSON.stringify(key)}),cert:await readFile(${JSON.stringify(cert)})},(_request,response)=>response.end('untrusted'));
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        try {
          await assert.rejects(()=>fetch('https://127.0.0.1:'+server.address().port),error=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.cause?.code));
        } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        console.log(JSON.stringify({defaultsPreserved:true,systemRootsIncluded:true,untrustedPeerRejected:true}));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:entry,logLevel:'silent'});
    const electron=z.string().parse(createRequire(import.meta.url)('electron'));
    const {stdout}=await run(electron,[entry],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:30000});
    assert.deepEqual(JSON.parse(stdout.trim()),{defaultsPreserved:true,systemRootsIncluded:true,untrustedPeerRejected:true});
  } finally {await rm(directory,{recursive:true,force:true});}
});

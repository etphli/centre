import test from 'node:test';
import assert from 'node:assert/strict';
import { studentContext,readCurriculum,getCurriculumContext } from './curriculum';

test('NSW learner context defaults to Year 9 and explicit subject years override it',() => {
  assert.equal(studentContext('Mathematics').yearLevel,9);
  assert.equal(studentContext('Year10Maths').yearLevel,10);
  assert.equal(studentContext('Year 10 Maths',9).stage,5);
  assert.equal(studentContext('Year 8 English',9).stage,4);
  assert.equal(studentContext('Year 12 Biology',9).stage,6);
  assert.equal(studentContext('Science',10).yearLevel,10);
});

test('curriculum retrieval uses actual response text, follows only official redirects and reports failures honestly',async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async input => {
    requests++; const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/redirect-test') return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
    if (url.pathname === '/large-test') return new Response('x',{headers:{'content-type':'text/html','content-length':'3000000'}});
    if (url.pathname === '/pdf-test') return new Response('pdf',{headers:{'content-type':'application/pdf'}});
    if (url.pathname.includes('science-7-10-2023')) return new Response('unavailable',{status:503});
    const outcome = (code: string,stage: string) => ({system:{type:'outcome'},elements:{code:{value:code},description:{value:'<p>This is test-only retrieved outcome text.</p>'},stages__stages:{value:[{name:stage}]}}});
    const embedded = {props:{pageProps:{data:{syllabus:{linkedItems:{early:outcome('MA2-FIXTURE-01','Stage 2'),secondary:outcome('MA5-FIXTURE-01','Stage 5')}}}}}};
    return new Response(`<html><title>Official fixture syllabus</title><main><script>DO NOT INCLUDE SCRIPT</script><h1>Stage 2</h1><p>This fixture simulates the initial visible stage, while secondary outcomes are supplied in the official page's embedded data.</p></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(embedded)}</script></html>`,{headers:{'content-type':'text/html'}});
  };
  try {
    await assert.rejects(readCurriculum('https://example.com/'),/official NSW/);
    await assert.rejects(readCurriculum('https://curriculum.nsw.edu.au.evil.test/'),/official NSW/);
    await assert.rejects(readCurriculum('https://curriculum.nsw.edu.au:444/'),/official NSW/);
    assert.equal(requests,0);
    await assert.rejects(readCurriculum('https://curriculum.nsw.edu.au/redirect-test'),/official NSW/); assert.equal(requests,1);
    await assert.rejects(readCurriculum('https://curriculum.nsw.edu.au/large-test'),/size limit/);
    await assert.rejects(readCurriculum('https://curriculum.nsw.edu.au/pdf-test'),/HTML or text/);
    const context = await getCurriculumContext('Year10Maths',9);
    assert.equal(context.student.yearLevel,10); assert.equal(context.student.stage,5); assert.equal(context.verified,true);
    assert.match(context.evidence[0]?.text ?? '',/MA5-FIXTURE-01/); assert.ok(!context.evidence[0]?.text.includes('DO NOT INCLUDE SCRIPT')); assert.ok(context.evidence[0]?.fetchedAt);
    assert.deepEqual(context.evidence[0]?.outcomes.map(outcome => outcome.code),['MA5-FIXTURE-01']);
    const failed = await getCurriculumContext('Science',9); assert.equal(failed.verified,false); assert.equal(failed.evidence.length,0); assert.match(failed.errors[0] ?? '',/503/);
    const unknown = await getCurriculumContext('Unknown elective',9); assert.equal(unknown.verified,false); assert.equal(unknown.evidence.length,0);
  } finally { globalThis.fetch = original; }
});

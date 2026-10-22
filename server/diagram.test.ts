import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramArtifactDocument,diagramDocument,diagramTheme } from './diagram';

test('diagram documents remain self-contained and theme bridges do not accumulate on export',() => {
  const input = '<!doctype html><html><head><style>.panel{background:white}</style></head><body><button onclick="this.textContent=\'Done\'">Explore</button></body></html>';
  const document = diagramDocument(input,'light');
  assert.ok(document.indexOf("connect-src 'none'") < document.indexOf('<button'));
  assert.match(document,/--centre-bg:#f9f9f7/);
  assert.match(document,/onclick="this.textContent='Done'"/);
  assert.match(document,/centre:diagram-size/);
  assert.match(document,/event.source===parent/);
  assert.equal((document.match(/<html>/g) ?? []).length,1);
  const rewrapped = diagramDocument(document,'dark');
  assert.equal((rewrapped.match(/<!--centre:bridge-->/g) ?? []).length,1);
  assert.equal((rewrapped.match(/<html>/g) ?? []).length,1);
  assert.match(rewrapped,/--centre-bg:#1b1b1a/);
  assert.equal(diagramTheme('light'),'light');
  assert.equal(diagramTheme('bad-css'),undefined);
});

test('artifact wrapper keeps generated markup inside an opaque srcdoc and a navigation-blocking parent policy',() => {
  const artifact = diagramArtifactDocument('<label><input type=checkbox>Review</label><script>const html="</scriptx><input type=checkbox>";</script>','dark',{resourceId:'resource</script><script>bad()</script>',documentRevision:'a'.repeat(64)});
  assert.match(artifact,/frame-src 'none'/);
  assert.match(artifact,/sandbox="allow-scripts"/);
  assert.match(artifact,/event.source===frame.contentWindow/);
  assert.match(artifact,/event.source===parent/);
  assert.match(artifact,/frame.srcdoc=/);
  assert.equal((artifact.match(/<script>/g) ?? []).length,1,'Generated markup and resource IDs cannot break out of the trusted wrapper script');
  assert.ok(artifact.includes('\\u003c'));
});


test('navigation recovery contains static escaped labels and supported IDs, without generated scripts',() => {
  const artifact = diagramArtifactDocument('<label for="study">Study &lt;script&gt; safely</label><input id="study" type="checkbox" checked data-centre-checklist-id="study"><label><input type="checkbox">Pack <b>notes</b></label><script>window.generatedAttack=true</script>','light',{resourceId:'resource',documentRevision:'a'.repeat(64)});
  const literal = /frame\.srcdoc=("(?:\\.|[^"\\])*");/.exec(artifact)?.[1];
  assert.ok(literal);
  const recovery:string = JSON.parse(literal);
  assert.match(recovery,/Study &lt;script&gt; safely/);
  assert.match(recovery,/Pack notes/);
  assert.match(recovery,/data-centre-checklist-id="study" checked/);
  assert.match(recovery,/data-centre-checklist-id="legacy-2"/);
  assert.doesNotMatch(recovery,/generatedAttack/);
  assert.match(recovery,/centre:checklist-ready/);
  assert.match(artifact,/if\(recovered\)return;recovered=true/);
});

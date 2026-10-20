import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramDocument,diagramTheme } from './diagram';

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

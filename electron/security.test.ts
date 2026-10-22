import assert from 'node:assert/strict';
import { test } from 'node:test';
import { printPaperSchema, saveFileSchema, validateExternalUrl, validateRequest } from './security';

test('IPC accepts only service routes and their intended methods', () => {
  for (const [method, path] of [['GET', '/api/state'], ['POST','/api/questions/00000000-0000-4000-8000-000000000000/answer'], ['PATCH','/api/chats/chat-1/model'], ['POST','/api/resources/quiz-1/archive'], ['POST','/api/resources/quiz-1/restore'], ['POST', '/api/chats/chat-123/branch'], ['POST', '/api/chats/chat-123/retry'], ['POST', '/api/chats/chat-123/messages'], ['POST', '/api/chats/chat-123/cancel'], ['POST','/api/attachments'], ['GET','/api/attachments/00000000-0000-4000-8000-000000000000'], ['PATCH', '/api/settings'], ['GET', '/api/resources/test_1/export'], ['GET', '/api/resources/diagram_1/preview']]) {
    assert.equal(validateRequest(method, path, undefined).path, path);
  }
  for (const [method, path] of [['DELETE', '/api/state'], ['POST', '/api/state'], ['GET', 'https://example.com/api/state'], ['GET', '/api/../state'], ['GET', '/api/resources/%2e%2e/export'], ['GET', '/api/state?token=x'], ['GET', '/api//state'], ['POST', '/api/settings/secret'], ['POST', '/api/resources/diagram_1/preview'], ['GET', '/artifacts/diagram_1/capability']]) {
    assert.throws(() => validateRequest(method, path, undefined));
  }
  assert.throws(() => validateRequest('GET', '/api/state', {}));
  assert.throws(() => validateRequest('POST', '/api/chats', { content: 'x'.repeat(2_000_001) }));
  assert.equal(validateRequest('POST','/api/attachments',{ data:'x'.repeat(2_000_001) }).method,'POST');
  assert.throws(() => validateRequest('POST','/api/attachments',{ data:'x'.repeat(30_000_001) }));
  assert.throws(() => validateRequest('GET','/api/attachments/not-a-uuid',undefined));
  assert.equal(validateRequest('POST','/api/resources/diagram_1/checklist-progress',{documentRevision:'a'.repeat(64),itemId:'one',checked:true}).method,'POST');
  assert.throws(() => validateRequest('GET','/api/resources/diagram_1/checklist-progress',undefined));
  assert.throws(() => validateRequest('POST','/api/resources/diagram_1/checklist-progress',{extra:'x'.repeat(16_384)}));
});

test('system browser rejects file, script, credential, and arbitrary localhost URLs', () => {
  assert.equal(validateExternalUrl('https://accounts.google.com/o/oauth2/v2/auth'), 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(validateExternalUrl('http://127.0.0.1:4321/oauth/callback'), 'http://127.0.0.1:4321/oauth/callback');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'http://127.0.0.1:4321/api/state', 'http://localhost/oauth/callback']) {
    assert.throws(() => validateExternalUrl(url));
  }
});

test('desktop search accepts one bounded encoded query and keeps other routes query free', () => {
  const path = `/api/search?q=${encodeURIComponent('café, cell-wall 日本語')}`;
  assert.equal(validateRequest('GET', path, undefined).path, path);
  for (const rejected of ['/api/search', '/api/search?q=one&q=two', '/api/search?token=secret', `/api/search?q=${'x'.repeat(161)}`, '/api/state?q=cell']) {
    assert.throws(() => validateRequest('GET', rejected, undefined));
  }
  assert.throws(() => validateRequest('POST', '/api/search?q=cell', undefined));
});

test('native file operations validate names and require real LaTeX for paper printing', () => {
  assert.equal(saveFileSchema.parse({ filename: 'test.tex', content: 'text', mimeType: 'application/x-tex' }).filename, 'test.tex');
  for (const filename of ['../secret', '/tmp/file', 'folder\\file', '..', '']) assert.equal(saveFileSchema.safeParse({ filename, content: '', mimeType: 'text/plain' }).success, false);
  assert.equal(printPaperSchema.safeParse({ title: 'Paper', html: '<p>Not LaTeX</p>' }).success, false);
});

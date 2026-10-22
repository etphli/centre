#!/usr/bin/env node
// Deterministic CLI protocol fixture. Centre routing and persistence remain real.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const configPath = process.env.CENTRE_STUDY_TOOL_INPUT;
const pending = new Map();
let sequence = 100;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function finish(threadId, content) {
  send({ method: 'item/completed', params: { threadId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ response: { kind: 'message', content, resourceIds: [] } }) } } });
  send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method && pending.has(message.id)) {
    const { threadId, phase, config } = pending.get(message.id); pending.delete(message.id);
    if (phase === 'read' && message.result.success && !config.readOnly) {
      const id = ++sequence; pending.set(id, { threadId, phase: 'write', config });
      send({ id, method: 'item/tool/call', params: { threadId: config.inactive ? 'not-an-active-chat' : threadId, tool: 'centre_log_study', arguments: config.input } });
    } else {
      appendFileSync(configPath + '.results', JSON.stringify({ phase, result: message.result }) + '\n');
      finish(threadId, message.result.success ? phase === 'read' ? 'Read actual study log.' : 'Logged completed paper study. You can check it in Log.' : 'Study was not saved.');
    }
    return;
  }
  if (!message.id || !message.method) return;
  let result = {};
  if (message.method === 'account/read') result = { account: { id: 'local-protocol-fixture' } };
  if (message.method === 'model/list') result = { data: [{ model: 'gpt-6.1-sol', displayName: 'Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null };
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    writeFileSync(configPath + '.thread', JSON.stringify(message.params));
    result = { thread: { id: message.params.threadId || randomUUID() } };
  }
  send({ id: message.id, result });
  if (message.method === 'turn/start') {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const id = ++sequence; pending.set(id, { threadId: message.params.threadId, phase: 'read', config });
    send({ id, method: 'item/tool/call', params: { threadId: message.params.threadId, tool: 'centre_get_study_log', arguments: {} } });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopActionRequestSchema, desktopActions, desktopActionUrl, type DesktopActionRequest } from '../shared/desktop-actions';
import { createDesktopActionDelivery, createDesktopWindowOpener } from './desktop-actions';

function delivery() {
  const received: DesktopActionRequest[] = [];
  const errors: unknown[] = [];
  return { received, errors, queue: createDesktopActionDelivery(request => received.push(request), error => errors.push(error)) };
}

test('only exact shared action URLs enter the queue', () => {
  const { queue, received } = delivery();
  for (const value of [
    'centre://action/unknown', 'CENTRE://action/chat.new', 'centre://ACTION/chat.new',
    'centre://action/chat.new/', 'centre://action/chat.new?start=true',
    'centre://action/chat.new#fragment', 'centre://action/chat%2enew',
    'centre://action/../chat.new', 'centre://user@action/chat.new',
    'centre://action:80/chat.new', ' centre://action/chat.new',
    'https://action/chat.new', '--url=centre://action/chat.new',
  ]) assert.equal(queue.enqueueUrl(value), false, value);
  for (const action of desktopActions) assert.equal(queue.enqueueUrl(desktopActionUrl(action.id)), true);
  queue.ready();
  for (const action of desktopActions) {
    const request = received.at(-1);
    assert.ok(request);
    assert.equal(request.action, action.id);
    assert.equal(desktopActionRequestSchema.safeParse(request).success, true);
    queue.acknowledge(request.id);
  }
  assert.equal(received.length, desktopActions.length);
});

test('startup argv waits for explicit ready, then drains serially by UUID acknowledgement', () => {
  const { queue, received } = delivery();
  queue.enqueueArgv(['electron', '/app', 'centre://action/chat.new', '--flag', 'centre://action/app.settings']);
  assert.equal(received.length, 0);
  queue.ready();
  assert.equal(received.length, 1);
  const first = received[0];
  assert.ok(first);
  queue.ready();
  queue.acknowledge('00000000-0000-4000-8000-000000000000');
  assert.equal(received.length, 1);
  queue.acknowledge(first.id);
  assert.equal(received.length, 2);
  assert.equal(received[1]?.action, 'app.settings');
  queue.acknowledge(first.id);
  assert.equal(received.length, 2);
});

test('warm invocations of the same action each receive their own UUID', () => {
  const { queue, received } = delivery();
  queue.ready();
  queue.enqueueUrl('centre://action/study-log.timer');
  queue.enqueueUrl('centre://action/study-log.timer');
  const first = received[0];
  assert.ok(first);
  queue.acknowledge(first.id);
  assert.equal(received.length, 2);
  assert.notEqual(received[1]?.id, first.id);
  assert.deepEqual(received.map(request => request.action), ['study-log.timer', 'study-log.timer']);
});

test('reload waits for fresh readiness and never replays a delivered request', () => {
  const { queue, received } = delivery();
  queue.ready();
  queue.enqueueUrl('centre://action/chat.new');
  queue.enqueueUrl('centre://action/app.resources');
  const first = received[0];
  assert.ok(first);
  queue.unready();
  queue.enqueueUrl('centre://action/app.calendar');
  queue.acknowledge(first.id);
  assert.equal(received.length, 1);
  queue.ready();
  assert.equal(received.length, 2);
  const second = received[1];
  assert.ok(second);
  assert.equal(second.action, 'app.resources');
  queue.acknowledge(first.id);
  assert.equal(received.length, 2);
  queue.acknowledge(second.id);
  assert.deepEqual(received.map(request => request.action), ['chat.new', 'app.resources', 'app.calendar']);
});

test('readiness changes with no invocation never create an action', () => {
  const { queue, received } = delivery();
  queue.ready();
  queue.unready();
  queue.ready();
  assert.deepEqual(received, []);
});

test('failed sends are reported, retained, and retried only after explicit readiness', () => {
  const received: DesktopActionRequest[] = [];
  const errors: unknown[] = [];
  const failure = new Error('renderer destroyed');
  let fails = true;
  const queue = createDesktopActionDelivery(request => {
    if (fails) throw failure;
    received.push(request);
  }, error => errors.push(error));
  queue.enqueueUrl('centre://action/chat.new');
  queue.ready();
  assert.deepEqual(errors, [failure]);
  fails = false;
  queue.enqueueUrl('centre://action/app.search');
  assert.equal(received.length, 0);
  queue.ready();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.action, 'chat.new');
});

test('closed windows open once for simultaneous invocations, then restore, show and focus', async () => {
  const calls: string[] = [];
  const window = {
    isMinimized: () => true,
    restore: () => { calls.push('restore'); },
    show: () => { calls.push('show'); },
    focus: () => { calls.push('focus'); },
  };
  let current: typeof window | null = null;
  let finish: () => void = () => { throw new Error('creation was not started'); };
  const open = createDesktopWindowOpener({
    available: () => true,
    getWindow: () => current,
    createWindow: () => {
      calls.push('create');
      return new Promise<void>(resolve => { finish = () => { current = window; resolve(); }; });
    },
  });
  const first = open();
  const second = open();
  assert.deepEqual(calls, ['create']);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['create', 'restore', 'show', 'focus', 'restore', 'show', 'focus']);
});

test('hidden windows show without recreation and startup events wait for the service', async () => {
  const calls: string[] = [];
  let available = false;
  const open = createDesktopWindowOpener({
    available: () => available,
    getWindow: () => ({
      isMinimized: () => false,
      restore: () => { calls.push('restore'); },
      show: () => { calls.push('show'); },
      focus: () => { calls.push('focus'); },
    }),
    createWindow: async () => { calls.push('create'); },
  });
  await open();
  assert.deepEqual(calls, []);
  available = true;
  await open();
  assert.deepEqual(calls, ['show', 'focus']);
});

test('window creation failures reject and allow a subsequent attempt', async () => {
  let attempts = 0;
  const open = createDesktopWindowOpener({
    available: () => true,
    getWindow: () => null,
    createWindow: async () => { attempts++; throw new Error('load failed'); },
  });
  await assert.rejects(open(), /load failed/);
  await assert.rejects(open(), /load failed/);
  assert.equal(attempts, 2);
});

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopLauncherManager } from './desktop-launchers';
import { desktopActionSchema, desktopActionUrl, type DesktopAction } from '../shared/desktop-actions';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'centre-launchers-')));
  roots.push(root);
  const desktopDirectory = join(root, 'Desktop');
  const manifestDirectory = join(root, 'private');
  mkdirSync(desktopDirectory);
  const options = { desktopDirectory, manifestDirectory };
  return { root, ...options, manager: new DesktopLauncherManager(options), restart: () => new DesktopLauncherManager(options) };
}
async function status(manager: DesktopLauncherManager, action: DesktopAction = 'study-log.manual') {
  const result = (await manager.list()).find(value => value.action === action);
  assert.ok(result);
  return result;
}
async function target(f: ReturnType<typeof fixture>, action: DesktopAction = 'study-log.manual') {
  return join(f.desktopDirectory, (await status(f.manager, action)).filename);
}

test('creates only requested named XML launcher with the exact allowlisted URL', async () => {
  const f = fixture();
  assert.ok((await f.manager.list()).every(value => value.state === 'absent'));
  for (const action of desktopActionSchema.options) {
    await f.manager.change(action, 'create');
    const path = await target(f, action);
    const xml = readFileSync(path, 'utf8');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes(`<key>URL</key>\n  <string>${desktopActionUrl(action)}</string>`));
    assert.ok(xml.endsWith('</plist>\n'));
    assert.equal((await status(f.manager, action)).state, 'installed');
  }
  assert.equal(readdirSync(f.desktopDirectory).length, desktopActionSchema.options.length);
  assert.equal((await status(f.manager, 'study-log.week')).filename, 'Centre – Study summary.inetloc');
  const manifest: unknown = JSON.parse(readFileSync(join(f.manifestDirectory, 'manifest.json'), 'utf8'));
  assert.ok(typeof manifest === 'object' && manifest !== null && 'version' in manifest && manifest.version === 1);
});

test('repeat operations and concurrent calls change only the selected action', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 6 }, () => f.manager.change('study-log.manual', 'create')));
  await f.manager.change('chat.new', 'create');
  await f.manager.change('study-log.manual', 'repair');
  assert.equal(readdirSync(f.desktopDirectory).length, 2);
  await Promise.all([f.manager.change('study-log.manual', 'remove'), f.manager.change('study-log.manual', 'remove')]);
  assert.equal((await status(f.manager)).state, 'absent');
  assert.equal((await status(f.manager, 'chat.new')).state, 'installed');
});

test('missing owned files can be repaired across manager restart', async () => {
  const f = fixture();
  await f.manager.change('study-log.manual', 'create');
  const path = await target(f);
  const expected = readFileSync(path, 'utf8');
  unlinkSync(path);
  const restarted = f.restart();
  assert.equal((await status(restarted)).state, 'missing');
  await restarted.change('study-log.manual', 'repair');
  assert.equal(readFileSync(path, 'utf8'), expected);
  unlinkSync(path);
  await restarted.change('study-log.manual', 'remove');
  assert.equal((await status(restarted)).state, 'absent');
  await assert.rejects(restarted.change('study-log.manual', 'repair'), /unowned/);
});

test('existing identical untracked files are never adopted, overwritten, or removed', async () => {
  const f = fixture();
  await f.manager.change('study-log.manual', 'create');
  const path = await target(f);
  const expected = readFileSync(path, 'utf8');
  await f.manager.change('study-log.manual', 'remove');
  writeFileSync(path, expected);
  assert.equal((await status(f.manager)).state, 'conflict');
  for (const operation of ['create', 'repair', 'remove'] satisfies ('create' | 'repair' | 'remove')[]) {
    await assert.rejects(f.manager.change('study-log.manual', operation), /conflict/);
    assert.equal(readFileSync(path, 'utf8'), expected);
  }
});

test('modified owned files and byte-identical replacement files are protected', async () => {
  for (const replacement of [false, true]) {
    const f = fixture();
    await f.manager.change('study-log.manual', 'create');
    const path = await target(f);
    const expected = readFileSync(path, 'utf8');
    if (replacement) {
      renameSync(path, join(f.root, 'original'));
      writeFileSync(path, expected);
    } else writeFileSync(path, 'user edits');
    assert.equal((await status(f.manager)).state, 'conflict');
    for (const operation of ['create', 'repair', 'remove'] satisfies ('create' | 'repair' | 'remove')[]) {
      await assert.rejects(f.manager.change('study-log.manual', operation), /conflict/);
    }
    assert.equal(readFileSync(path, 'utf8'), replacement ? expected : 'user edits');
  }
});

test('moving a modified owned icon aside permits repair or removal without touching user edits', async () => {
  for (const operation of ['repair', 'remove'] satisfies ('repair' | 'remove')[]) {
    const f = fixture();
    await f.manager.change('chat.new', 'create');
    const path = await target(f, 'chat.new');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, 'my edited launcher');
    assert.equal((await status(f.manager, 'chat.new')).state, 'conflict');
    const saved = join(f.desktopDirectory, 'My saved icon.inetloc');
    renameSync(path, saved);
    assert.equal((await status(f.manager, 'chat.new')).state, 'missing');
    await f.restart().change('chat.new', operation);
    assert.equal(readFileSync(saved, 'utf8'), 'my edited launcher');
    assert.equal((await status(f.manager, 'chat.new')).state, operation === 'repair' ? 'installed' : 'absent');
    if (operation === 'repair') assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('symlink and directory launchers are conflicts and their destinations survive', async () => {
  for (const tracked of [false, true]) {
    for (const kind of ['symlink', 'directory']) {
      const f = fixture();
      const path = await target(f);
      if (tracked) { await f.manager.change('study-log.manual', 'create'); unlinkSync(path); }
      const destination = join(f.root, 'user-file');
      writeFileSync(destination, 'preserve');
      if (kind === 'symlink') symlinkSync(destination, path);
      else mkdirSync(path);
      assert.equal((await status(f.manager)).state, 'conflict');
      await assert.rejects(f.manager.change('study-log.manual', 'remove'), /conflict/);
      await assert.rejects(f.manager.change('study-log.manual', 'repair'), /conflict/);
      assert.equal(readFileSync(destination, 'utf8'), 'preserve');
    }
  }
});

test('corrupt or unsafe manifest fails closed for reads and all mutations', async () => {
  for (const text of ['{', '{"version":2,"entries":[]}', '{"version":1,"entries":[{"action":"../../escape"}]}', '{"version":1,"entries":[],"extra":true}']) {
    const f = fixture();
    await f.manager.change('study-log.manual', 'create');
    const path = await target(f);
    const expected = readFileSync(path, 'utf8');
    writeFileSync(join(f.manifestDirectory, 'manifest.json'), text);
    await assert.rejects(f.manager.list());
    for (const operation of ['create', 'repair', 'remove'] satisfies ('create' | 'repair' | 'remove')[]) {
      await assert.rejects(f.manager.change('study-log.manual', operation));
      assert.equal(readFileSync(path, 'utf8'), expected);
    }
  }
});

test('manifest symlinks, nonregular manifests and redirected directories fail closed', async () => {
  const f = fixture();
  await f.manager.list();
  const user = join(f.root, 'user-manifest');
  writeFileSync(user, '{"version":1,"entries":[]}');
  const manifest = join(f.manifestDirectory, 'manifest.json');
  symlinkSync(user, manifest);
  await assert.rejects(f.manager.change('chat.new', 'create'));
  assert.equal(readFileSync(user, 'utf8'), '{"version":1,"entries":[]}');
  unlinkSync(manifest);
  mkdirSync(manifest);
  await assert.rejects(f.manager.list());
  rmSync(f.manifestDirectory, { recursive: true });
  const other = join(f.root, 'other');
  mkdirSync(other);
  symlinkSync(other, f.manifestDirectory);
  await assert.rejects(f.manager.list(), /Unsafe launcher directory/);
  assert.deepEqual(readdirSync(other), []);
  rmSync(f.manifestDirectory);
  symlinkSync(other, join(f.root, 'redirect'));
  const redirected = new DesktopLauncherManager({ desktopDirectory: join(f.root, 'redirect'), manifestDirectory: join(f.root, 'private2') });
  await assert.rejects(redirected.list(), /Unsafe launcher directory/);
});

test('lost or altered ownership anchors cannot authorize repair or removal', async () => {
  const f = fixture();
  await f.manager.change('study-log.manual', 'create');
  const anchor = readdirSync(f.manifestDirectory).find(name => name.endsWith('.inetloc'));
  assert.ok(anchor);
  unlinkSync(join(f.manifestDirectory, anchor));
  assert.equal((await status(f.manager)).state, 'conflict');
  await assert.rejects(f.manager.change('study-log.manual', 'remove'), /conflict/);
  await assert.rejects(f.manager.change('study-log.manual', 'repair'), /conflict/);
});

test('arbitrary actions and operations fail before filesystem mutation; queue recovers', async () => {
  const f = fixture();
  for (const action of ['../escape', '/tmp/escape', 'chat.new?x=1', '', null, {}, ['chat.new']]) {
    await assert.rejects(f.manager.change(action, 'create'));
  }
  // Exercise the JavaScript IPC boundary with an invalid operation without a type assertion.
  await assert.rejects(Reflect.apply(f.manager.change, f.manager, ['chat.new', 'overwrite']));
  assert.deepEqual(readdirSync(f.desktopDirectory), []);
  assert.deepEqual(readdirSync(f.root), ['Desktop']);
  await f.manager.change('chat.new', 'create');
  assert.equal((await status(f.manager, 'chat.new')).state, 'installed');
  assert.throws(() => new DesktopLauncherManager({ desktopDirectory: 'relative', manifestDirectory: f.manifestDirectory }));
  assert.throws(() => new DesktopLauncherManager({ desktopDirectory: f.desktopDirectory, manifestDirectory: f.desktopDirectory }));
});

test('lost manifests and interrupted private staging never grant ownership', async () => {
  const f = fixture();
  await f.manager.change('study-log.manual', 'create');
  const path = await target(f);
  const expected = readFileSync(path, 'utf8');
  unlinkSync(join(f.manifestDirectory, 'manifest.json'));
  assert.equal((await status(f.restart())).state, 'conflict');
  await assert.rejects(f.restart().change('study-log.manual', 'remove'), /conflict/);
  assert.equal(readFileSync(path, 'utf8'), expected);
  unlinkSync(path);
  // The abandoned private source is untracked. A new create must establish fresh ownership.
  await f.restart().change('study-log.manual', 'create');
  assert.equal((await status(f.restart())).state, 'installed');
  const before = readFileSync(join(f.manifestDirectory, 'manifest.json'), 'utf8');
  const parsed: unknown = JSON.parse(before);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'entries' in parsed && Array.isArray(parsed.entries));
  writeFileSync(join(f.manifestDirectory, 'manifest.json'), JSON.stringify({ version: 1, entries: [...parsed.entries, ...parsed.entries] }));
  await assert.rejects(f.manager.list());
  assert.equal(readFileSync(path, 'utf8'), expected);
});

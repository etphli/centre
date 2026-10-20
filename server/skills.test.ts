import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkills, readSkillInstruction, loadApplicableSkills } from './skills';

const fixtureSkill = { id: 'sample', name: 'Sample', description: 'A study skill.', source: 'Test fixture', files: ['SKILL.md'] };

test('bundled skill catalog loads actual named instructions and supporting references', async () => {
  const skills = await listSkills();
  assert.equal(skills.length, 18);
  for (const id of ['unslop', 'poteto-mode', 'how', 'why', 'teach', 'research', 'exam-prep', 'active-recall']) assert.ok(skills.some(skill => skill.id === id), id);
  for (const skill of skills) {
    const instruction = await readSkillInstruction(skill.id);
    assert.equal(instruction.name, skill.name);
    assert.equal(instruction.source, skill.source);
    assert.match(instruction.content, /Centre runtime adaptation/);
    assert.match(instruction.content, /Bundled file: SKILL.md/);
    assert.ok(Buffer.byteLength(instruction.content) < 64 * 1024);
  }
  assert.match((await readSkillInstruction('why')).content, /Bundled file: references\/epistemics.md/);
  const original = await readFile('skills/unslop/SKILL.md', 'utf8');
  assert.ok((await readSkillInstruction('unslop')).content.includes(original));
});

test('automatic skill selection uses registered IDs for chat and each resource kind', async () => {
  const ids = async (text: string, kind?: Parameters<typeof loadApplicableSkills>[0]['kind']) => (await loadApplicableSkills({ text, kind })).map(skill => skill.id);
  assert.deepEqual(await ids('Hello'), ['unslop']);
  assert.deepEqual(await ids('Why and how? Teach me.'), ['unslop', 'how', 'why', 'teach']);
  assert.deepEqual(await ids('Draw a diagram', 'diagram'), ['unslop', 'study-diagrams']);
  assert.deepEqual(await ids('A practice paper', 'test'), ['unslop', 'exam-prep']);
  assert.deepEqual(await ids('Questions', 'quiz'), ['unslop', 'active-recall']);
  assert.deepEqual(await ids('Cards', 'flashcards'), ['unslop', 'active-recall']);
  assert.deepEqual(await ids('/poteto-mode, use bro'), ['unslop', 'poteto-mode', 'bro']);
  assert.deepEqual(await ids('A technique somehow involves examiners'), ['unslop']);
});

test('skill loader accepts only catalog IDs and bounded files inside its configured root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-skills-'));
  const root = join(directory, 'skills');
  const previous = process.env.CENTRE_SKILLS_DIR;
  await mkdir(join(root, 'sample'), { recursive: true });
  process.env.CENTRE_SKILLS_DIR = root;
  const writeManifest = async (skills: unknown[] = [fixtureSkill]) => writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, skills }));
  try {
    await writeManifest();
    await writeFile(join(root, 'sample', 'SKILL.md'), '# Real fixture');
    assert.match((await readSkillInstruction('sample')).content, /Real fixture/);
    assert.deepEqual(await loadApplicableSkills({ text: 'Why does this diagram work?', kind: 'test' }), []);
    await t.test('denies traversal, absolute paths and unknown IDs', async () => {
      for (const id of ['../sample', '/tmp/sample', 'sample/SKILL.md', 'sample\\SKILL.md', 'sample%2f..', 'missing']) await assert.rejects(readSkillInstruction(id));
    });
    await t.test('denies duplicate IDs and paths escaping the manifest root', async () => {
      await writeManifest([fixtureSkill, fixtureSkill]);
      await assert.rejects(listSkills());
      await writeManifest([{ ...fixtureSkill, files: ['SKILL.md', '../secret.md'] }]);
      await assert.rejects(readSkillInstruction('sample'));
      await writeManifest();
    });
    await t.test('denies symlinks escaping through files and directories', async () => {
      const outside = join(directory, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'SKILL.md'), 'Private outside file');
      await rm(join(root, 'sample', 'SKILL.md'));
      await symlink(join(outside, 'SKILL.md'), join(root, 'sample', 'SKILL.md'));
      await assert.rejects(readSkillInstruction('sample'), /outside/);
      await rm(join(root, 'sample'), { recursive: true });
      await symlink(outside, join(root, 'sample'));
      await assert.rejects(readSkillInstruction('sample'), /outside/);
      await rm(join(root, 'sample'));
      await mkdir(join(root, 'sample'));
    });
    await t.test('denies oversized instructions and manifest files', async () => {
      await writeFile(join(root, 'sample', 'SKILL.md'), 'a'.repeat(64 * 1024 + 1));
      await assert.rejects(readSkillInstruction('sample'), /too large/);
      await writeFile(join(root, 'sample', 'SKILL.md'), 'a'.repeat(64 * 1024));
      await assert.rejects(readSkillInstruction('sample'), /size limit/);
      await writeFile(join(root, 'manifest.json'), ' '.repeat(64 * 1024 + 1));
      await assert.rejects(listSkills(), /too large/);
    });
  } finally {
    if (previous === undefined) delete process.env.CENTRE_SKILLS_DIR;
    else process.env.CENTRE_SKILLS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

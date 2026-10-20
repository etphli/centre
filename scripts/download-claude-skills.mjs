import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const digest = data => createHash('sha256').update(data).digest('hex');
const lockSchema = z.object({
  repository: z.literal('anthropics/skills'), revision: z.string().regex(/^[a-f0-9]{40}$/),
  skills: z.array(z.object({ id: z.string().regex(/^claude-[a-z0-9-]+$/), upstream: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), description: z.string(), files: z.array(z.object({ path: z.enum(['SKILL.md', 'LICENSE.txt']), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) })),
});
const lock = lockSchema.parse(JSON.parse(await readFile(resolve(root, 'claude-sources.json'), 'utf8')));
const staged = [];
for (const skill of lock.skills) {
  for (const file of skill.files) {
    const target = resolve(root, skill.id, file.path);
    try { if (digest(await readFile(target)) === file.sha256) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const url = `https://raw.githubusercontent.com/${lock.repository}/${lock.revision}/skills/${skill.upstream}/${file.path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error(`Could not download ${skill.id}/${file.path}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 64 * 1024 || digest(data) !== file.sha256) throw new Error(`Downloaded skill failed verification: ${skill.id}/${file.path}`);
    staged.push({ target, data });
  }
}
for (const { target, data } of staged) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, data); await rename(`${target}.tmp`, target);
}
const manifestPath = resolve(root, 'manifest.json');
const original = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(original);
manifest.skills = manifest.skills.filter(skill => !skill.id.startsWith('claude-'));
for (const skill of lock.skills) manifest.skills.push({ id: skill.id, name: skill.name, description: skill.description, source: `Anthropic Claude skills: ${skill.upstream}`, originSha256: skill.files.find(file => file.path === 'SKILL.md').sha256, files: ['SKILL.md'] });
const content = `${JSON.stringify(manifest, null, 2)}\n`;
if (content !== original) { await writeFile(`${manifestPath}.tmp`, content); await rename(`${manifestPath}.tmp`, manifestPath); }
console.log(`Verified ${lock.skills.length} Claude skills${staged.length ? `; downloaded ${staged.length} files` : ' from the offline bundle'}.`);

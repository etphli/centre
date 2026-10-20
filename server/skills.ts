import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { HttpError } from './errors';
import type { ResourceKind } from '../shared/schema';

const maximumBytes = 64 * 1024;
const relativeMarkdown = z.string().min(1).max(180).refine(value => !isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part !== '.' && part !== '..' && part.length > 0) && value.endsWith('.md'));
const skillSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  source: z.string().min(1).max(200),
  originSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  files: z.array(relativeMarkdown).min(1).max(12).refine(files => files[0] === 'SKILL.md' && new Set(files).size === files.length),
}).strict();
const manifestSchema = z.object({ version: z.literal(1), skills: z.array(skillSchema).max(100).refine(skills => new Set(skills.map(skill => skill.id)).size === skills.length) }).strict();

const runtimeNote = `# Centre runtime adaptation

These are bundled instructions, not extra tool permissions. Apply their reasoning and writing methods using only tools available in this conversation. The original skill comes from a coding-agent environment; Centre is a study app. This adaptation takes precedence over original workflow and tool assumptions.

Use available Centre tools to inspect study context and Organato, and save notes, resources or calendar entries only when the current request authorizes the action. Use web research only when a web-search tool is actually available. Otherwise use supplied material and clearly identify claims you cannot verify. Never claim to have searched, run code, browsed files, consulted an unavailable integration, delegated or saved something without a successful tool result.

For original terminal, filesystem, git, deployment, scripts, MCP discovery, subagent and named model instructions, carry out the relevant thinking in the current conversation. Centre does not grant these capabilities. Software lifecycle playbooks are reference material, not actions to execute. Do not request unavailable scripts or references. Only the supporting references included below are available for this skill. Load another bundled skill through centre_read_skill when it is useful. For how, why and teach, use the student's topic or supplied materials as the subject, rather than assuming a repository. Research deliverables belong in the response or a requested Centre note. Keep skill workflow mechanics out of the student's explanation.
`;

async function safeFile(root: string, path: string, limit: number) {
  const canonicalPath = await realpath(resolve(root, path));
  const location = relative(root, canonicalPath);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw new HttpError(400, 'Skill file is outside the bundled skills directory.');
  const info = await stat(canonicalPath);
  if (!info.isFile() || info.size > limit) throw new HttpError(400, 'Skill file is invalid or too large.');
  const value = await readFile(canonicalPath, 'utf8');
  if (Buffer.byteLength(value) > limit) throw new HttpError(400, 'Skill file is too large.');
  return value;
}

async function loadManifest() {
  const root = await realpath(resolve(process.env.CENTRE_SKILLS_DIR ?? 'skills'));
  const manifest = manifestSchema.parse(JSON.parse(await safeFile(root, 'manifest.json', maximumBytes)));
  return { root, skills: manifest.skills };
}

export async function listSkills(): Promise<Array<{ id: string; name: string; description: string; source: string }>> {
  const { skills } = await loadManifest();
  return skills.map(({ id, name, description, source }) => ({ id, name, description, source }));
}

export async function readSkillInstruction(id: string): Promise<{ id: string; name: string; content: string; source: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) throw new HttpError(400, 'Invalid skill ID.');
  const { root, skills } = await loadManifest();
  const skill = skills.find(candidate => candidate.id === id);
  if (!skill) throw new HttpError(404, 'Skill not found.');
  const sections = [runtimeNote];
  for (const file of skill.files) sections.push(`\n## Bundled file: ${file}\n\n${await safeFile(root, `${skill.id}/${file}`, maximumBytes)}`);
  const content = sections.join('\n');
  if (Buffer.byteLength(content) > maximumBytes) throw new HttpError(400, 'Skill instructions exceed the size limit.');
  return { id: skill.id, name: skill.name, content, source: skill.source };
}


export async function loadApplicableSkills({ text, kind }: { text: string; kind?: ResourceKind }): Promise<Array<{ id: string; name: string; content: string; source: string }>> {
  const available = new Set((await listSkills()).map(skill => skill.id));
  const selected = new Set(['unslop']);
  const routes: Array<[string, RegExp]> = [
    ['poteto-mode', /\bpoteto(?:-mode)?\b/i],
    ['how', /\bhow\b/i],
    ['why', /\bwhy\b/i],
    ['teach', /\b(?:teach|explain)\b/i],
    ['research', /\bresearch\b/i],
    ['technical-writing', /\b(?:technical[- ]writing|write documentation)\b/i],
    ['bro', /(?:^|\s)(?:\$|\/)?bro\b/i],
    ['grilling', /\b(?:grill|grilling|stress[- ]test)\b/i],
    ['study-diagrams', /\b(?:diagram|diagrams|visualise|visualize|visualisation|visualization)\b/i],
    ['exam-prep', /\b(?:exam|exams|exam-prep|practice[- ]paper|revision)\b/i],
    ['active-recall', /\b(?:active[- ]recall|flashcards?|quiz|quizzes)\b/i],
    ['study-plan', /\b(?:study[- ]plan|study[- ]schedule|revision[- ]plan)\b/i],
    ['essay-writing', /\b(?:essay|essays|essay-writing)\b/i],
    ['worked-examples', /\b(?:worked[- ]examples?|step[- ]by[- ]step)\b/i],
    ['source-checking', /\b(?:source[- ]checking|fact[- ]check|check (?:the )?(?:sources|citations))\b/i],
    ['codebase-design', /\bcodebase[- ]design\b/i],
    ['domain-modeling', /\bdomain[- ]model(?:ing|ling)\b/i],
  ];
  for (const [id, pattern] of routes) if (pattern.test(text)) selected.add(id);
  if (kind === 'diagram') selected.add('study-diagrams');
  if (kind === 'test') selected.add('exam-prep');
  if (kind === 'quiz' || kind === 'flashcards') selected.add('active-recall');
  const result = [];
  for (const id of selected) if (available.has(id)) result.push(await readSkillInstruction(id));
  return result;
}

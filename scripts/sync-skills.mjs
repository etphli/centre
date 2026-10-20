import { createHash } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.argv[2] ?? join(homedir(), '.codex', 'skills'));
const targetRoot = join(projectRoot, 'skills');
const imported = [
  ['unslop', 'Unslop', 'Edit writing into plain, natural prose. Apply to every written response.'],
  ['poteto-mode', 'Poteto mode', 'Use poteto or /poteto-mode for concise prose, deliberate reasoning and verified results.'],
  ['how', 'How', 'Explain how a concept, process or supplied code works, step by step.'],
  ['why', 'Why', 'Investigate causes, rationale and tradeoffs, separating evidence from inference.'],
  ['teach', 'Teach', 'Teach a topic by connecting how it works with why it works.'],
  ['research', 'Research', 'Research a question using available sources and produce a cited brief.'],
  ['technical-writing', 'Technical writing', 'Write or revise clear instructions, explanations, reports and technical documents.'],
  ['bro', 'Bro', 'Restate the previous explanation in plain language with minimal jargon.'],
  ['grilling', 'Grilling', 'Stress-test a claim, plan or argument with focused questions.'],
  ['codebase-design', 'Codebase design', 'Explain or critique interfaces and module boundaries in supplied code.'],
  ['domain-modeling', 'Domain modeling', 'Clarify concepts, relationships and terminology in a subject or supplied design.'],
];
const authored = [
  ['ask-questions', 'Ask questions', 'Ask for missing preferences or confirmation in a popup using centre_ask_question.'],
  ['active-recall', 'Active recall', 'Quiz the student interactively, diagnose gaps and revisit missed concepts.'],
  ['exam-prep', 'Exam prep', 'Prepare practice exams and targeted revision from course topics and weaknesses.'],
  ['study-plan', 'Study plan', 'Build a realistic revision plan around deadlines, available time and review needs.'],
  ['study-diagrams', 'Study diagrams', 'Explain relationships or processes with clear self-contained interactive study diagrams.'],
  ['essay-writing', 'Essay writing', 'Plan, review or revise essays with a clear argument and evidence.'],
  ['worked-examples', 'Worked examples', 'Teach mathematical or technical problems through worked steps and transfer practice.'],
  ['source-checking', 'Source checking', 'Check claims, citations and source quality while preserving uncertainty.'],
];
const support = {
  how: ['references/explorer-prompt.md', 'references/explainer-prompt.md', 'references/critique-rubric.md'],
  why: ['references/epistemics.md'],
  'codebase-design': ['DEEPENING.md', 'DESIGN-IT-TWICE.md'],
  'domain-modeling': ['CONTEXT-FORMAT.md', 'ADR-FORMAT.md'],
};
const skills = [];
for (const [id, name, description] of imported) {
  const original = await readFile(join(sourceRoot, id, 'SKILL.md'));
  for (const file of ['SKILL.md', ...(support[id] ?? [])]) {
    const destination = join(targetRoot, id, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, id, file), destination);
  }
  skills.push({ id, name, description, source: `Installed Codex skill: ${id}`, originSha256: createHash('sha256').update(original).digest('hex'), files: ['SKILL.md', ...(support[id] ?? [])] });
}
for (const [id, name, description] of authored) {
  await readFile(join(targetRoot, id, 'SKILL.md'));
  skills.push({ id, name, description, source: 'Centre study skills', files: ['SKILL.md'] });
}
await writeFile(join(targetRoot, 'manifest.json'), `${JSON.stringify({ version: 1, skills }, null, 2)}\n`);
console.log(`Bundled ${skills.length} Centre skills. Existing global skills were read only.`);

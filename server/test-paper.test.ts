import assert from 'node:assert/strict';
import test from 'node:test';
import { questionSchema, type Resource } from '../shared/schema';
import { getTestSections } from '../shared/test-paper';
import { paperTemplate } from './test-paper';

type TestQuestion = Resource['questions'][number];

const makeQuestion = (
  id: string,
  responseType: TestQuestion['responseType'],
  marks: number,
  prompt = `Prompt ${id}.`,
  answer = `Answer ${id}.`,
): TestQuestion => questionSchema.parse({
  id,
  concept: '',
  responseType,
  choices: responseType === 'multiple_choice' ? ['Choice A', 'Choice B'] : [],
  prompt,
  answer,
  explanation: `Explanation ${id}.`,
  marks,
});

test('test sections use fixed response order, omit empty groups, and keep source questions', () => {
  const questions = [
    makeQuestion('long-one', 'long_response', 5),
    makeQuestion('short-one', 'short_response', 2),
    makeQuestion('mc-one', 'multiple_choice', 1),
    makeQuestion('short-two', 'short_response', 3),
  ];
  const sections = getTestSections(questions);

  assert.deepEqual(sections.map(section => ({
    letter: section.letter,
    name: section.name,
    responseType: section.responseType,
    startNumber: section.startNumber,
    questionCount: section.questionCount,
    marks: section.marks,
    questionIds: section.questions.map(question => question.id),
  })), [
    { letter: 'A', name: 'Multiple choice', responseType: 'multiple_choice', startNumber: 1, questionCount: 1, marks: 1, questionIds: ['mc-one'] },
    { letter: 'B', name: 'Short response', responseType: 'short_response', startNumber: 2, questionCount: 2, marks: 5, questionIds: ['short-one', 'short-two'] },
    { letter: 'C', name: 'Long response', responseType: 'long_response', startNumber: 4, questionCount: 1, marks: 5, questionIds: ['long-one'] },
  ]);
  assert.equal(sections[0]?.questions[0], questions[2]);
  assert.equal(sections[1]?.questions[0], questions[1]);
});

test('paper cover stands alone and summarizes every section and the full total', () => {
  const questions = [
    makeQuestion('long', 'long_response', 4, 'Long prompt.', 'Long answer.'),
    makeQuestion('mc', 'multiple_choice', 2, 'MC prompt.', 'Choice A'),
    makeQuestion('short', 'short_response', 3, 'Short prompt.', 'Short answer.'),
  ];
  const paper = paperTemplate('Fractions test', 'Maths', questions, { mode: 'time', minutes: 35 }, 'Fractions');
  const cover = paper.slice(paper.indexOf('\\begin{titlepage}'), paper.indexOf('\\end{titlepage}'));

  assert.ok(cover.includes('Fractions test'));
  assert.ok(cover.includes('Maths'));
  assert.ok(cover.includes('Topic: Fractions'));
  assert.ok(cover.includes('Duration: 35 minutes'));
  assert.ok(cover.includes('Total marks: 9'));
  assert.match(cover, /Part A.*Multiple choice.*1.*2/);
  assert.match(cover, /Part B.*Short response.*1.*3/);
  assert.match(cover, /Part C.*Long response.*1.*4/);
  assert.match(cover, /Total.*3.*9/);
  assert.ok(!cover.includes('MC prompt.'));
  assert.ok(!cover.includes('Long prompt.'));
  assert.ok(paper.indexOf('\\end{titlepage}') < paper.indexOf('\\begin{enumerate}[label=\\arabic*.,leftmargin=*,itemsep=12mm,start=1]'));
});

test('paper sections and marking guidance use the same reordered numbering', () => {
  const questions = [
    makeQuestion('long', 'long_response', 4, 'Long prompt.', 'Long answer.'),
    makeQuestion('short', 'short_response', 3, 'Short prompt.', 'Short answer.'),
    makeQuestion('mc', 'multiple_choice', 2, 'MC prompt.', 'Choice A'),
  ];
  const paper = paperTemplate('Unit test', 'Science', questions);
  const promptPositions = ['MC prompt.', 'Short prompt.', 'Long prompt.'].map(prompt => paper.indexOf(prompt));
  const answerPositions = ['Choice A', 'Short answer.', 'Long answer.'].map(answer => paper.lastIndexOf(answer));

  assert.ok(promptPositions[0]! < promptPositions[1]! && promptPositions[1]! < promptPositions[2]!);
  assert.ok(answerPositions[0]! < answerPositions[1]! && answerPositions[1]! < answerPositions[2]!);
  assert.match(paper, /start=1\]/);
  assert.match(paper, /start=2\]/);
  assert.match(paper, /start=3\]/);
  assert.ok(paper.includes('Answers and marking guidance}\\par'));
  assert.ok(paper.indexOf('\\clearpage\n{\\Large\\bfseries Answers and marking guidance}') > promptPositions[2]!);
});

test('paper omits empty sections and escapes metadata', () => {
  const paper = paperTemplate(
    'A & B #1 \\input{file}',
    'Maths & science',
    [makeQuestion('one', 'short_response', 2, 'Prompt.', 'Answer.')],
    45,
    'A_50% topic',
  );
  const cover = paper.slice(paper.indexOf('\\begin{titlepage}'), paper.indexOf('\\end{titlepage}'));

  assert.ok(cover.includes('A \\& B \\#1'));
  assert.ok(cover.includes('\\textbackslash{}input\\{file\\}'));
  assert.ok(!cover.includes('\\input{file}'));
  assert.ok(cover.includes('Maths \\& science'));
  assert.ok(cover.includes('A\\_50\\% topic'));
  assert.ok(cover.includes('Duration: 45 minutes'));
  assert.ok(!paper.includes('Part A: Multiple choice'));
  assert.ok(paper.includes('Part A: Short response'));
  assert.ok(!paper.includes('Part B:'));
});

test('paper supports question-count mode and preserves the legacy default', () => {
  const questions = [makeQuestion('one', 'short_response', 1)];

  assert.ok(paperTemplate('Counted', 'Maths', questions, { mode: 'questions', questionCount: 1 }).includes('Question count: 1'));
  assert.ok(paperTemplate('Legacy', 'Maths', questions).includes('Duration: 45 minutes'));
});

test('graphing questions get model-selected working space and a plotted answer without revealing it on the paper', () => {
  const axes = { xMin:-3,xMax:7,yMin:-12,yMax:10,curves:[],points:[] };
  const question = questionSchema.parse({
    ...makeQuestion('graph', 'long_response', 6, 'Sketch $y=x^{2}-2x-8$.', 'Vertex $(1,-9)$.'),
    paperLayout:{workingSpace:{kind:'lines',lines:6},graphPlacement:'beside',startOnNewPage:false,
      questionGraph:axes,answerGraph:{...axes,curves:[{a:1,b:-2,c:-8,label:'y'}],points:[{x:1,y:-9,label:'V'}]}},
  });
  const paper = paperTemplate('Graph practice','Maths',[question]);
  const [questions,answers] = paper.split('{\\Large\\bfseries Answers and marking guidance}');
  assert.match(questions!, /\\begin\{tikzpicture\}/);
  assert.match(questions!, /\\begin\{minipage\}/);
  assert.ok(!questions!.includes('plot coordinates'));
  assert.match(answers!, /plot coordinates/);
  assert.ok(!paper.includes('\\vspace{28mm}'));
});

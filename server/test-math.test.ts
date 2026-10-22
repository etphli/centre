import assert from 'node:assert/strict';
import test from 'node:test';
import { questionSchema, type Resource } from '../shared/schema';
import { normalizePaperMath } from './test-math';
import { paperTemplate } from './test-paper';

type TestQuestion = Resource['questions'][number];

const question: TestQuestion = questionSchema.parse({
  id: 'triangle',
  concept: '',
  responseType: 'multiple_choice',
  choices: [
    'x = √(13² + 5²)',
    'x = 13 − 5',
    'x = √(13² − 5²)',
    'x = 13² − 5²',
  ],
  prompt: 'Find x = √(13² + 5²).',
  answer: 'x = √(13² + 5²)',
  explanation: 'Use π, θ, and 30° when describing the angle.',
  marks: 1,
});

test('normalizes the legacy triangle expressions in plain text', () => {
  assert.equal(normalizePaperMath('x = √(13² + 5²)'), '\\ensuremath{x = \\sqrt{13^{2} + 5^{2}}}');
  assert.equal(normalizePaperMath('x = 13 − 5'), '\\ensuremath{x = 13 - 5}');
  assert.equal(normalizePaperMath('x = √(13² − 5²)'), '\\ensuremath{x = \\sqrt{13^{2} - 5^{2}}}');
  assert.equal(normalizePaperMath('x = 13² − 5²'), '\\ensuremath{x = 13^{2} - 5^{2}}');
});

test('converts common operators, Greek symbols, degrees, and bare square roots', () => {
  assert.equal(
    normalizePaperMath('Calculate 2 × 3 ÷ 4, then compare 2 ≤ 3, 4 ≥ 3, 5 ≠ 6, and 1 ± 2.'),
    'Calculate \\ensuremath{2 \\times 3 \\div 4}, then compare \\ensuremath{2 \\leq 3}, \\ensuremath{4 \\geq 3}, \\ensuremath{5 \\ne 6}, and \\ensuremath{1 \\pm 2}.',
  );
  assert.equal(normalizePaperMath('The angle θ = 30° uses π.'), 'The angle \\ensuremath{\\theta = 30^{\\circ}} uses \\ensuremath{\\pi}.');
  assert.equal(normalizePaperMath('√49 is the square root.'), '\\ensuremath{\\sqrt{49}} is the square root.');
});

test('converts symbols inside math delimiters and preserves existing LaTeX', () => {
  assert.equal(normalizePaperMath('$x = √(13² + 5²)$'), '$x = \\sqrt{13^{2} + 5^{2}}$');
  assert.equal(normalizePaperMath(String.raw`\(2 × 3\)`), String.raw`\(2 \times 3\)`);
  assert.equal(normalizePaperMath(String.raw`\[πr²\]`), String.raw`\[\pi r^{2}\]`);
  assert.equal(normalizePaperMath('$\\frac{1}{2} + \\sqrt{4}$'), '$\\frac{1}{2} + \\sqrt{4}$');
  assert.equal(normalizePaperMath('The cost is \\$5.'), 'The cost is \\$5.');
});

test('leaves quoted prose unchanged', () => {
  const text = 'The learner wrote “x = √(13² + 5²)” and said "it is done".';
  assert.equal(normalizePaperMath(text), text);
});

test('normalizes test fragments and keeps singular marks together', () => {
  const paper = paperTemplate('Pythagoras\' theorem', 'Maths', [question], 45, ' pYthagoras\' theorem ');

  assert.ok(paper.includes('\\item Find \\ensuremath{x = \\sqrt{13^{2} + 5^{2}}}. \\hfill \\mbox{[1 mark]}'));
  assert.ok(paper.includes('\\item \\ensuremath{x = \\sqrt{13^{2} + 5^{2}}}'));
  assert.ok(paper.includes('\\ensuremath{x = 13^{2} - 5^{2}}'));
  assert.ok(paper.includes('\\item \\ensuremath{x = \\sqrt{13^{2} + 5^{2}}}\\par Use \\ensuremath{\\pi}, \\ensuremath{\\theta}, and \\ensuremath{30^{\\circ}}'));
  assert.ok(!paper.includes('Topic:'));
});

test('normalizes approximate values after roots and existing math', () => {
  assert.equal(normalizePaperMath('h = √84 ≈ 9.2 m.'), String.raw`\ensuremath{h = \sqrt{84} \approx 9.2} m.`);
  assert.equal(normalizePaperMath('$h=\\sqrt{84}$ ≈ 9.2 m.'), String.raw`$h=\sqrt{84}$ \ensuremath{\approx} 9.2 m.`);
});

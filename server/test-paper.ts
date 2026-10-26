import type { Resource, TestLength } from '../shared/schema';
import { getTestSections } from '../shared/test-paper';
import { normalizePaperMath } from './test-math';
import { questionPaperLayout, type PaperLayout } from '../shared/paper-layout';
import { graphLatex } from './paper-graph';

const latexEscape = (value: string) => value.replace(/[\\{}$&#%_~^]/g, char => ({
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  '_': '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}[char] ?? char));

const sizeHeader = (testLength: TestLength | number) => {
  if (typeof testLength === 'number') return `Duration: ${testLength} minutes`;
  if (testLength.mode === 'time') return `Duration: ${testLength.minutes} minutes`;
  return `Question count: ${testLength.questionCount}`;
};

const sectionInstructions: Record<Resource['questions'][number]['responseType'], string> = {
  multiple_choice: 'Choose one answer for each question.',
  short_response: 'Write a brief answer in the space provided.',
  long_response: 'Show your working and explain your reasoning.',
};

const totalMarks = (questions: Resource['questions']) => questions.reduce((total, question) => total + question.marks, 0);

function workingSpace(space:PaperLayout['workingSpace']) {
  switch (space.kind) {
    case 'none': return '';
    case 'blank': return `\\par\\vspace{${space.heightMm}mm}`;
    case 'lines': return Array.from({length:space.lines},()=>'\\par\\vspace{7mm}\\noindent\\rule{\\linewidth}{0.2pt}').join('\n');
  }
}
function questionWorkspace(layout:PaperLayout) {
  const working = workingSpace(layout.workingSpace);
  if (!layout.questionGraph) return working;
  const graph = graphLatex(layout.questionGraph,latexEscape);
  return layout.graphPlacement === 'beside' && layout.workingSpace.kind !== 'none'
    ? `\\par\\medskip\\noindent\\begin{minipage}[t]{0.47\\linewidth}\\vspace{0pt}\n${working}\n\\end{minipage}\\hfill\\begin{minipage}[t]{0.49\\linewidth}\\vspace{0pt}\n${graph}\n\\end{minipage}`
    : `${working}\n\\par\\medskip\\noindent\\begin{minipage}{0.75\\linewidth}\n${graph}\n\\end{minipage}`;
}

export function paperTemplate(
  title: string,
  subject: string,
  questions: Resource['questions'],
  testLength: TestLength | number = 45,
  topic?: string,
): string {
  const sections = getTestSections(questions);
  const questionTotal = questions.length;
  const marksTotal = totalMarks(questions);
  const normalizedTopic = topic?.trim();
  const showTopic = normalizedTopic && normalizedTopic.toLowerCase() !== title.trim().toLowerCase();
  const topicLine = showTopic ? `Topic: ${latexEscape(normalizedTopic)}\\par\\medskip\n` : '';
  const sectionRows = sections.map(section =>
    `\\textbf{Part ${section.letter}} & ${section.name} & ${section.questionCount} & ${section.marks} \\\\ \\hline`,
  ).join('\n');
  const sectionPages = sections.map((section, sectionIndex) => {
    const renderedQuestions = section.questions.map(question => {
      const layout = questionPaperLayout(question);
      const choices = question.responseType === 'multiple_choice'
        ? `\n\\begin{enumerate}[label=\\Alph*.,leftmargin=*,itemsep=2mm]\n${question.choices.map(choice => `\\item ${normalizePaperMath(choice)}`).join('\n')}\n\\end{enumerate}`
        : '';
      const markLabel = question.marks === 1 ? 'mark' : 'marks';
      const workHeight = layout.workingSpace.kind === 'lines' ? layout.workingSpace.lines*8 : layout.workingSpace.kind === 'blank' ? layout.workingSpace.heightMm : 0;
      const workspaceHeight = layout.questionGraph ? layout.graphPlacement === 'beside' ? Math.max(workHeight,70) : workHeight+105 : workHeight;
      const breakBefore = layout.startOnNewPage ? '\\newpage\n' : `\\Needspace{${Math.min(215,35+workspaceHeight)}mm}\n`;
      return `${breakBefore}\\item ${normalizePaperMath(question.prompt)} \\hfill \\mbox{[${question.marks} ${markLabel}]}${choices}\n${questionWorkspace(layout)}`;
    }).join('\n');
    const pageBreak = sectionIndex === 0 ? '' : '\\clearpage\n';
    return `${pageBreak}{\\Large\\bfseries Part ${section.letter}: ${section.name}}\\par\\medskip
Questions: ${section.questionCount} \\hfill Marks: ${section.marks}\\par
${sectionInstructions[section.responseType]}\\par\\bigskip
\\begin{enumerate}[label=\\arabic*.,leftmargin=*,itemsep=12mm,start=${section.startNumber}]
${renderedQuestions}
\\end{enumerate}`;
  }).join('\n');
  const answers = sections.flatMap(section => section.questions).map(question => {
    const graph = questionPaperLayout(question).answerGraph;
    return `${graph?'\\Needspace{150mm}\n':''}\\item ${normalizePaperMath(question.answer)}\\par ${normalizePaperMath(question.explanation)}${graph?`\n\\par\\medskip\\noindent\\begin{minipage}{0.65\\linewidth}\n${graphLatex(graph,latexEscape)}\n\\end{minipage}`:''}`;
  }).join('\n');
  const hasGraphs = questions.some(question=>question.paperLayout?.questionGraph || question.paperLayout?.answerGraph);

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=22mm]{geometry}
\\usepackage{amsmath,amssymb,fancyhdr,enumitem}
\\usepackage{needspace}${hasGraphs?'\n\\usepackage{tikz}':''}
\\usepackage[T1]{fontenc}
\\pagestyle{fancy}
\\fancyhf{}
\\lhead{Centre | ${latexEscape(subject)}}
\\rhead{Practice paper}
\\cfoot{\\thepage}
\\setlength{\\headheight}{14pt}
\\setlength{\\parindent}{0pt}
\\begin{document}
\\begin{titlepage}
\\centering
\\vspace*{\\fill}
{\\Large ${latexEscape(subject)}}\\par\\medskip
${topicLine}{\\huge\\bfseries ${latexEscape(title)}}\\par\\bigskip
${sizeHeader(testLength)}\\par\\medskip
Total marks: ${marksTotal}\\par\\bigskip
\\begin{tabular}{|c|l|r|r|}
\\hline
\\textbf{Part} & \\textbf{Section} & \\textbf{Questions} & \\textbf{Marks} \\\\ \\hline
${sectionRows}${sectionRows ? '\n' : ''}\\textbf{Total} & & ${questionTotal} & ${marksTotal} \\\\ \\hline
\\end{tabular}
\\vspace*{\\fill}
\\end{titlepage}
${sectionPages ? `${sectionPages}\n` : ''}\\clearpage
{\\Large\\bfseries Answers and marking guidance}\\par\\bigskip
\\begin{enumerate}[label=\\arabic*.,leftmargin=*,itemsep=8mm,start=1]
${answers}
\\end{enumerate}
\\end{document}
`;
}

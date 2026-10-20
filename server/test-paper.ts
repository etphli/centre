import type { Resource, TestLength } from '../shared/schema';
import { getTestSections } from '../shared/test-paper';
import { normalizePaperMath } from './test-math';

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
      const choices = question.responseType === 'multiple_choice'
        ? `\n\\begin{enumerate}[label=\\Alph*.,leftmargin=*,itemsep=2mm]\n${question.choices.map(choice => `\\item ${normalizePaperMath(choice)}`).join('\n')}\n\\end{enumerate}`
        : '';
      const markLabel = question.marks === 1 ? 'mark' : 'marks';
      return `\\item ${normalizePaperMath(question.prompt)} \\hfill \\mbox{[${question.marks} ${markLabel}]}${choices}\n\\par\\vspace{28mm}`;
    }).join('\n');
    const pageBreak = sectionIndex === 0 ? '' : '\\clearpage\n';
    return `${pageBreak}{\\Large\\bfseries Part ${section.letter}: ${section.name}}\\par\\medskip
Questions: ${section.questionCount} \\hfill Marks: ${section.marks}\\par
${sectionInstructions[section.responseType]}\\par\\bigskip
\\begin{enumerate}[label=\\arabic*.,leftmargin=*,itemsep=12mm,start=${section.startNumber}]
${renderedQuestions}
\\end{enumerate}`;
  }).join('\n');
  const answers = sections.flatMap(section => section.questions).map(question =>
    `\\item ${normalizePaperMath(question.answer)}\\par ${normalizePaperMath(question.explanation)}`,
  ).join('\n');

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=22mm]{geometry}
\\usepackage{amsmath,amssymb,fancyhdr,enumitem}
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

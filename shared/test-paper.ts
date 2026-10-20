import { responseTypeValues, type Resource, type ResponseType } from './schema';

export type TestPaperQuestion = Resource['questions'][number];

export type TestSection = {
  letter: string;
  name: string;
  responseType: ResponseType;
  startNumber: number;
  questions: TestPaperQuestion[];
  questionCount: number;
  marks: number;
};

const sectionNames: Record<ResponseType, string> = {
  multiple_choice: 'Multiple choice',
  short_response: 'Short response',
  long_response: 'Long response',
};

export function getTestSections(questions: readonly TestPaperQuestion[]): TestSection[] {
  const sections: TestSection[] = [];
  let startNumber = 1;

  for (const responseType of responseTypeValues) {
    const sectionQuestions = questions.filter(question => question.responseType === responseType);
    if (sectionQuestions.length === 0) continue;

    const questionCount = sectionQuestions.length;
    sections.push({
      letter: String.fromCharCode(65 + sections.length),
      name: sectionNames[responseType],
      responseType,
      startNumber,
      questions: sectionQuestions,
      questionCount,
      marks: sectionQuestions.reduce((total, question) => total + question.marks, 0),
    });
    startNumber += questionCount;
  }

  return sections;
}

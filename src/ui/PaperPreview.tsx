import type { Resource } from '../../shared/schema';
import { getTestSections } from '../../shared/test-paper';
import { useApp } from './context';
import { plural } from './format';
import { Markdown } from './Markdown';
import './paper.css';

function mathText(text:string) {
  return /\\[a-zA-Z]+/.test(text) && !/\$|\\\(|\\\[/.test(text) ? `$${text.trim()}$` : text;
}

export function PaperPreview({resource}:{resource:Resource}) {
  const {state} = useApp();
  const sections = getTestSections(resource.questions);
  const total = sections.reduce((sum,section) => sum + section.marks,0);
  const subject = state.subjects.find(subject => subject.id === resource.subjectId);
  const topic = state.topics.find(topic => topic.id === resource.topicId);
  return <div className="paper-pages" aria-label="Test paper preview">
    <article className="paper paper--cover" aria-label="Test cover page">
      <div className="paper-cover__title"><p>{subject?.name}</p><h2>{resource.title}</h2>{topic && topic.name.trim().toLocaleLowerCase() !== resource.title.trim().toLocaleLowerCase() ? <p className="paper-cover__topic">{topic.name}</p> : null}<p className="paper-cover__duration">{resource.durationMinutes ? `${resource.durationMinutes} minutes` : plural(resource.questions.length,'question')}</p></div>
      <table className="paper-cover__parts"><caption>Test overview</caption><thead><tr><th scope="col">Part</th><th scope="col">Questions</th><th scope="col">Marks</th></tr></thead><tbody>{sections.map(section => <tr key={section.letter}><th scope="row"><span>{section.letter}</span> {section.name}</th><td>{section.questionCount}</td><td>{section.marks}</td></tr>)}</tbody><tfoot><tr><th scope="row">Full test</th><td>{resource.questions.length}</td><td>{total}</td></tr></tfoot></table>
      <p className="paper-cover__total">Total marks <strong>{total}</strong></p>
    </article>
    {sections.map(section => <article className="paper paper--section" key={section.letter} aria-label={`Part ${section.letter}: ${section.name}`}>
      <header className="paper-section__header"><span>Part {section.letter}</span><h3>{section.name}</h3><p>{plural(section.questionCount,'question')}, {plural(section.marks,'mark')}</p></header>
      <ol className="paper__questions" start={section.startNumber}>{section.questions.map(question => <li key={question.id} id={`resource-question-${question.id}`}><Markdown>{mathText(question.prompt)}</Markdown>{question.responseType === 'multiple_choice' ? <ol className="paper__choices" type="A">{question.choices.map(choice => <li key={choice}><Markdown>{mathText(choice)}</Markdown></li>)}</ol> : <div className={`paper__answer-space paper__answer-space--${question.responseType}`} aria-hidden />}<span className="paper__marks">[{question.marks}]</span></li>)}</ol>
    </article>)}
  </div>;
}

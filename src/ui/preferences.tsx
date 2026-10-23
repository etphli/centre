import { Select } from './Select';
import { QuestionTypes } from './QuestionTypes';
import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { preferencesSchema } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { ModelMenu } from './ModelMenu';
import './preferences.css';

type Preferences = z.infer<typeof preferencesSchema>;

export function PreferencesEffect() {
  const { state } = useApp();
  const { theme, density, textSize, readingFont, readingWidth, lineSpacing, reducedMotion, contrast } = state.settings;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.density = density; document.documentElement.dataset.textSize = textSize; }, [density, textSize]);
  useEffect(() => {
    Object.assign(document.documentElement.dataset, { readingFont, readingWidth, lineSpacing, reducedMotion, contrast });
  }, [readingFont, readingWidth, lineSpacing, reducedMotion, contrast]);
  return null;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <div className="preference-row"><div><div className="preference-row__title">{title}</div>{detail ? <p>{detail}</p> : null}</div><div className="preference-row__control">{children}</div></div>;
}

function Choice<T extends string>({ value, values, onChange, label }: { value: T; values: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return <div className="preference-choice" role="group" aria-label={label}>{values.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function usePreferenceSave() {
  const { refresh } = useApp();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  async function save(patch: Partial<Preferences>) {
    if (pending.current) return false;
    pending.current = true;
    const focused = document.activeElement;
    setBusy(true);
    setStatus('idle');
    try {
      await api.saveSettings(patch);
      await refresh();
      setStatus('saved');
      return true;
    } catch {
      setStatus('error');
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
      });
    }
  }
  const notice = <p className={`preference-save preference-save--${status}`} role={status === 'error' ? 'alert' : 'status'}>{busy ? 'Saving…' : status === 'error' ? 'Could not confirm the save. Check the connection and try again.' : status === 'saved' ? 'Preferences saved' : 'Changes save automatically'}</p>;
  return { save, busy, notice };
}

export function GeneralPreferences() {
  const { state } = useApp();
  const { save, busy, notice } = usePreferenceSave();
  const [nickname, setNickname] = useState(state.settings.nickname);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setNickname(state.settings.nickname), [state.settings.nickname]);
  async function saveNickname() {
    if (nickname.trim() !== state.settings.nickname && !await save({ nickname: nickname.trim() })) setNickname(state.settings.nickname);
  }
  return <>
    {notice}<fieldset className="preference-fields" disabled={busy}>
    <Row title="Nickname" detail="What Centre calls you in chat and greetings."><input aria-label="Nickname" value={nickname} maxLength={60} placeholder="Your name" onChange={event => setNickname(event.target.value)} onBlur={() => void saveNickname()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></Row>
    <Row title="Reset preferences" detail="Restore appearance, chat and study defaults. Your accounts, models, memories and saved work stay as they are.">
      {confirmReset ? <div className="preference-reset"><button className="button" onClick={() => void save(preferencesSchema.parse({})).then(saved => { if (saved) setConfirmReset(false); })}>Reset preferences now</button><button className="button button--quiet" onClick={() => setConfirmReset(false)}>Cancel</button></div> : <button className="button" onClick={() => setConfirmReset(true)}>Reset preferences…</button>}
    </Row></fieldset>
  </>;
}

export function AppearancePreferences() {
  const { state: { settings } } = useApp();
  const { save, busy, notice } = usePreferenceSave();
  return <>{notice}<fieldset className="preference-fields" disabled={busy}>
    <Row title="Theme"><div className="theme-options" role="group" aria-label="Theme">{(['dark','light','midnight','system'] satisfies Preferences['theme'][]).map(theme => <button type="button" className={`theme-option theme-option--${theme}`} aria-pressed={settings.theme === theme} key={theme} onClick={() => void save({ theme })}><span className="theme-option__preview" aria-hidden="true"><span /><span />{settings.theme === theme ? <Check size={12} /> : null}</span><span>{theme[0]?.toUpperCase()}{theme.slice(1)}</span></button>)}</div></Row>
    <Row title="Text size" detail="Scales text throughout Centre, including chats and resources."><Choice label="Text size" value={settings.textSize} values={[{ value:'small',label:'Small' },{ value:'standard',label:'Standard' },{ value:'large',label:'Large' },{ value:'extra-large',label:'Extra large' }]} onChange={textSize => void save({ textSize })} /></Row>
    <Row title="Spacing"><Choice label="Interface spacing" value={settings.density} values={[{ value:'compact',label:'Compact' },{ value:'comfortable',label:'Comfortable' }]} onChange={density => void save({ density })} /></Row>
    <h3 className="preferences-title">Reading</h3>
    <Row title="Reading font" detail="For chat prose and resource text. Code and maths keep their own fonts."><Choice label="Reading font" value={settings.readingFont} values={[{value:'default',label:'Default'},{value:'sans',label:'Sans serif'},{value:'serif',label:'Serif'}]} onChange={readingFont => void save({readingFont})} /></Row>
    <Row title="Reading width" detail="The space used by chats and resource pages."><Choice label="Reading width" value={settings.readingWidth} values={[{value:'narrow',label:'Narrow'},{value:'standard',label:'Standard'},{value:'wide',label:'Wide'}]} onChange={readingWidth => void save({readingWidth})} /></Row>
    <Row title="Line spacing"><Choice label="Line spacing" value={settings.lineSpacing} values={[{value:'standard',label:'Standard'},{value:'relaxed',label:'Relaxed'}]} onChange={lineSpacing => void save({lineSpacing})} /></Row>
    <div className="reading-preview" aria-label="Reading preview"><span className="preference-note">Reading preview</span><p className="reading-preview__text">Understanding starts with a question. Take an idea, explore it in your own words, and return to the parts that need another look.</p></div>
    <h3 className="preferences-title">Accessibility</h3>
    <Row title="Motion" detail="Follow your device preference, or reduce animations in Centre."><Choice label="Motion" value={settings.reducedMotion} values={[{value:'system',label:'Use system'},{value:'reduce',label:'Reduce'}]} onChange={reducedMotion => void save({reducedMotion})} /></Row>
    <Row title="Contrast" detail="Make secondary text and dividing lines more distinct."><Choice label="Contrast" value={settings.contrast} values={[{value:'standard',label:'Standard'},{value:'more',label:'More'}]} onChange={contrast => void save({contrast})} /></Row>
  </fieldset></>;
}

export function ChatPreferences() {
  const { state: { settings } } = useApp();
  const { save, busy, notice } = usePreferenceSave();
  return <>{notice}<fieldset className="preference-fields" disabled={busy}>
    <Row title="Send messages with" detail="Shift+Enter always adds a new line. The Send button works with either choice."><Choice label="Send messages with" value={settings.sendKey} values={[{value:'enter',label:'Enter'},{value:'modifier-enter',label:'⌘ / Ctrl + Enter'}]} onChange={sendKey => void save({sendKey})} /></Row>
    <Row title="Response activity" detail="Start thinking and tool details collapsed or expanded. You can open or close each response yourself."><Choice label="Response activity" value={settings.activityVisibility} values={[{value:'collapsed',label:'Collapsed'},{value:'expanded',label:'Expanded'}]} onChange={activityVisibility => void save({activityVisibility})} /></Row>
    <Row title="Greetings"><Choice label="Greetings" value={settings.greetingStyle} values={[{value:'rotating',label:'Varied'},{value:'simple',label:'Simple'}]} onChange={greetingStyle => void save({greetingStyle})} /></Row>
    <Row title="Response length" detail="How much explanation Centre includes."><Choice label="Response length" value={settings.responseStyle} values={[{ value:'concise',label:'Concise' },{ value:'balanced',label:'Balanced' },{ value:'detailed',label:'Detailed' }]} onChange={responseStyle => void save({ responseStyle })} /></Row>
  </fieldset></>;
}

type StudyField = 'timeZone' | 'defaultQuizQuestions' | 'defaultTestMinutes' | 'defaultTestQuestions' | 'defaultFlashcardCount';

function StudyInput({ field, label, min, max, step }: { field: StudyField; label: string; min?: number; max?: number; step?: number }) {
  const { state, refresh } = useApp();
  const saved = state.settings[field];
  const [value, setValue] = useState(String(saved));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  useEffect(() => setValue(String(saved)), [saved]);

  async function save(input: HTMLInputElement) {
    if (busy || value === String(saved)) return;
    const parsed = preferencesSchema.shape[field].safeParse(field === 'timeZone' ? value.trim() : Number(value));
    if (!value.trim() || !input.checkValidity() || !parsed.success) {
      setError(field === 'timeZone' ? 'Choose a valid time zone, for example Australia/Sydney.' : `Choose a whole number from ${min} to ${max}${step ? `, in steps of ${step}` : ''}.`);
      setValue(String(saved));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.saveSettings({ [field]: parsed.data });
      await refresh();
    } catch {
      setValue(String(saved));
      setError('Could not save this setting. Check the connection and try again.');
    } finally { setBusy(false); }
  }

  return <div className="preference-input">
    <input aria-label={label} type={field === 'timeZone' ? 'text' : 'number'} required min={min} max={max} step={step} value={value} disabled={busy}
      aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      onChange={event => { setValue(event.target.value); setError(''); }} onBlur={event => void save(event.currentTarget)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    {error ? <p id={errorId} role="alert" className="form__error">{error}</p> : null}
  </div>;
}

export function StudyPreferences() {
  const { state } = useApp();
  const settings = state.settings;
  const { save, busy, notice } = usePreferenceSave();
  return <>
    {notice}<fieldset className="preference-fields" disabled={busy}><h2 className="preferences-title">Your studies</h2>
    <Row title="School year" detail="NSW, Australia. A year in a subject’s name takes priority, including Year 10 Mathematics."><Select label="School year" value={String(settings.studentYearLevel)} onChange={value => save({ studentYearLevel:Number(value) })} options={[7,8,9,10,11,12].map(year => ({ value:String(year),label:`Year ${year}` }))} /></Row>
    <Row title="Curriculum" detail="Centre reads official NESA syllabus resources when preparing study material."><span className="preference-note">NSW / NESA</span></Row>
    <Row title="Time zone" detail="Calendar dates use this time zone, including daylight saving."><StudyInput label="Time zone" field="timeZone" /></Row>
    <h2 className="preferences-title">New resources</h2>
    <Row title="Flashcard count" detail="Used in the flashcard creation dialog. You can change it before creating."><Choice label="Default flashcard count mode" value={settings.defaultFlashcardCountMode} values={[{value:'auto',label:'Automatic'},{value:'fixed',label:'Choose count'}]} onChange={defaultFlashcardCountMode => void save({defaultFlashcardCountMode})} /></Row>
    {settings.defaultFlashcardCountMode === 'fixed' ? <Row title="Cards per set"><StudyInput label="Default flashcard count" field="defaultFlashcardCount" min={1} max={30} /></Row> : null}
    <Row title="Quiz questions"><StudyInput label="Default quiz questions" field="defaultQuizQuestions" min={1} max={30} /></Row>
    <Row title="Size tests by" detail="Your default is time. You can change the mode before each test."><Choice label="Default test length mode" value={settings.defaultTestLengthMode} values={[{value:'time',label:'Time'},{value:'questions',label:'Questions'}]} onChange={value => save({defaultTestLengthMode:value})} /></Row>
    <Row title="Test duration" detail="You can adjust the time and question types before every test."><div className="preference-number"><StudyInput label="Default test duration" field="defaultTestMinutes" min={5} max={180} /><span>minutes</span></div></Row>
    {settings.defaultTestLengthMode === 'questions' ? <Row title="Test questions"><StudyInput label="Default test questions" field="defaultTestQuestions" min={1} max={30} /></Row> : null}
    <Row title="Quiz question types"><QuestionTypes label="Default quiz question types" value={settings.defaultQuizQuestionTypes} onChange={value => save({ defaultQuizQuestionTypes:value })} keepOne /></Row>
    <Row title="Test question types"><QuestionTypes label="Default test question types" value={settings.defaultTestQuestionTypes} onChange={value => save({ defaultTestQuestionTypes:value })} keepOne /></Row>
    <Row title="Difficulty"><Choice label="Default difficulty" value={settings.defaultDifficulty} values={[{ value:'gentle',label:'Gentle' },{ value:'standard',label:'Standard' },{ value:'challenging',label:'Challenging' }]} onChange={value => void save({ defaultDifficulty:value })} /></Row></fieldset>
  </>;
}

export function ModelPreferences() {
  return <><Row title="Default chat model" detail="Used for new chats and creating resources. Change the model for an individual chat from its message bar."><ModelMenu target="default" /></Row><Row title="Quiz marking" detail="Choose the model that grades answers and explains mistakes. This is independent of your chat model."><ModelMenu target="grading" /></Row></>;
}

export function SkillsPreferences() {
  const [skills,setSkills] = useState<Awaited<ReturnType<typeof api.skills>>['skills']>([]);
  const [error,setError] = useState('');
  useEffect(() => { let live = true; api.skills().then(result => { if (live) setSkills(result.skills); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'Skills unavailable'); }); return () => { live = false; }; }, []);
  return <><h2 className="preferences-title">Skills</h2><p className="preferences-description">Centre selects relevant skills automatically. Official Claude skills download during setup and are included for offline use. Their writing, design and review methods work with Centre’s available tools.</p>{error ? <p role="alert">{error}</p> : null}<div className="skills-settings">{skills.map(skill => <div key={skill.id}><span className="skills-settings__name">{skill.name}</span><span className="skills-settings__description">{skill.description}</span><span className="preference-note">{skill.source.startsWith('Anthropic') ? 'Claude' : 'Automatic'}</span></div>)}</div></>;
}

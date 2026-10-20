import { Select } from './Select';
import { QuestionTypes } from './QuestionTypes';
import { Check } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { preferencesSchema } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { ModelMenu } from './ModelMenu';
import './preferences.css';

type Preferences = z.infer<typeof preferencesSchema>;

export function PreferencesEffect() {
  const { state } = useApp();
  const { theme, density, textSize } = state.settings;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.density = density; document.documentElement.dataset.textSize = textSize; }, [density, textSize]);
  return null;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <div className="preference-row"><div><div className="preference-row__title">{title}</div>{detail ? <p>{detail}</p> : null}</div><div className="preference-row__control">{children}</div></div>;
}

function Choice<T extends string>({ value, values, onChange, label }: { value: T; values: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return <div className="preference-choice" role="group" aria-label={label}>{values.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

export function GeneralPreferences() {
  const { state, act } = useApp();
  const settings = state.settings;
  const save = (patch: Partial<Preferences>) => { void act(() => api.saveSettings(patch)); };
  const [nickname, setNickname] = useState(settings.nickname);
  return <>
    <h2 className="preferences-title">Make yourself at home</h2>
    <Row title="Nickname" detail="What Centre calls you in chat and greetings."><input aria-label="Nickname" value={nickname} maxLength={60} placeholder="Your name" onChange={event => setNickname(event.target.value)} onBlur={() => { if (nickname.trim() !== settings.nickname) save({ nickname: nickname.trim() }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></Row>
    <Row title="Greetings" detail="A different opening each visit, matched to the time of day."><span className="preference-note">Automatic</span></Row>
    <Row title="Response length" detail="How much explanation Centre includes."><Choice label="Response length" value={settings.responseStyle} values={[{ value:'concise',label:'Concise' },{ value:'balanced',label:'Balanced' },{ value:'detailed',label:'Detailed' }]} onChange={value => save({ responseStyle:value })} /></Row>
    <h2 className="preferences-title">Appearance</h2>
    <Row title="Theme"><div className="theme-options" role="group" aria-label="Theme">{(['dark','light','midnight','system'] satisfies Preferences['theme'][]).map(theme => <button type="button" className={`theme-option theme-option--${theme}`} aria-pressed={settings.theme === theme} key={theme} onClick={() => save({ theme })}><span className="theme-option__preview"><span /><span />{settings.theme === theme ? <Check size={12} /> : null}</span><span>{theme[0]?.toUpperCase()}{theme.slice(1)}</span></button>)}</div></Row>
    <Row title="Spacing"><Choice label="Interface spacing" value={settings.density} values={[{ value:'compact',label:'Compact' },{ value:'comfortable',label:'Comfortable' }]} onChange={value => save({ density:value })} /></Row>
    <Row title="Text size"><Choice label="Text size" value={settings.textSize} values={[{ value:'small',label:'Small' },{ value:'standard',label:'Default' },{ value:'large',label:'Large' }]} onChange={value => save({ textSize:value })} /></Row>
  </>;
}

export function StudyPreferences() {
  const { state, act } = useApp();
  const settings = state.settings;
  const save = (patch: Partial<Preferences>) => { void act(() => api.saveSettings(patch)); };
  return <>
    <h2 className="preferences-title">Your studies</h2>
    <Row title="School year" detail="NSW, Australia. A year in a subject’s name takes priority, including Year 10 Mathematics."><Select label="School year" value={String(settings.studentYearLevel)} onChange={value => save({ studentYearLevel:Number(value) })} options={[7,8,9,10,11,12].map(year => ({ value:String(year),label:`Year ${year}` }))} /></Row>
    <Row title="Curriculum" detail="Centre reads official NESA syllabus resources when preparing study material."><span className="preference-note">NSW / NESA</span></Row>
    <Row title="Time zone" detail="Calendar dates use this time zone, including daylight saving."><input aria-label="Time zone" defaultValue={settings.timeZone} onBlur={event => { if (event.target.value !== settings.timeZone) save({ timeZone:event.target.value }); }} /></Row>
    <h2 className="preferences-title">New resources</h2>
    <Row title="Quiz questions"><input aria-label="Default quiz questions" type="number" min={1} max={30} defaultValue={settings.defaultQuizQuestions} onBlur={event => { if (event.target.checkValidity()) save({ defaultQuizQuestions:Number(event.target.value) }); }} /></Row>
    <Row title="Size tests by" detail="Your default is time. You can change the mode before each test."><Choice label="Default test length mode" value={settings.defaultTestLengthMode} values={[{value:'time',label:'Time'},{value:'questions',label:'Questions'}]} onChange={value => save({defaultTestLengthMode:value})} /></Row>
    <Row title="Test duration" detail="You can adjust the time and question types before every test."><div className="preference-number"><input aria-label="Default test duration" type="number" min={5} max={180} step={5} defaultValue={settings.defaultTestMinutes} onBlur={event => { if (event.target.checkValidity()) save({ defaultTestMinutes:Number(event.target.value) }); }} /><span>minutes</span></div></Row>
    {settings.defaultTestLengthMode === 'questions' ? <Row title="Test questions"><input aria-label="Default test questions" type="number" min={1} max={30} defaultValue={settings.defaultTestQuestions} onBlur={event => { if (event.target.checkValidity()) save({ defaultTestQuestions:Number(event.target.value) }); }} /></Row> : null}
    <Row title="Quiz question types"><QuestionTypes label="Default quiz question types" value={settings.defaultQuizQuestionTypes} onChange={value => save({ defaultQuizQuestionTypes:value })} keepOne /></Row>
    <Row title="Test question types"><QuestionTypes label="Default test question types" value={settings.defaultTestQuestionTypes} onChange={value => save({ defaultTestQuestionTypes:value })} keepOne /></Row>
    <Row title="Difficulty"><Choice label="Default difficulty" value={settings.defaultDifficulty} values={[{ value:'gentle',label:'Gentle' },{ value:'standard',label:'Standard' },{ value:'challenging',label:'Challenging' }]} onChange={value => save({ defaultDifficulty:value })} /></Row>
  </>;
}

export function ModelPreferences() {
  return <><Row title="Default chat model" detail="Used for new chats and creating resources. Change the model for an individual chat from its message bar."><ModelMenu target="default" /></Row><Row title="Quiz marking" detail="Choose the model that grades answers and explains mistakes. This is independent of your chat model."><ModelMenu target="grading" /></Row></>;
}

export function SkillsPreferences() {
  const [skills,setSkills] = useState<Awaited<ReturnType<typeof api.skills>>['skills']>([]);
  const [error,setError] = useState('');
  useEffect(() => { let live = true; api.skills().then(result => { if (live) setSkills(result.skills); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : 'Skills unavailable'); }); return () => { live = false; }; }, []);
  return <><h2 className="preferences-title">Skills</h2><p className="preferences-description">Centre selects relevant skills automatically. You can also ask for one by name.</p>{error ? <p role="alert">{error}</p> : null}<div className="skills-settings">{skills.map(skill => <div key={skill.id}><span className="skills-settings__name">{skill.name}</span><span className="skills-settings__description">{skill.description}</span><span className="preference-note">Automatic</span></div>)}</div></>;
}

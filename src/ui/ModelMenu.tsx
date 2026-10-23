import { Check, ChevronDown, RotateCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { modelSchema } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import './model-picker.css';

export function modelLabel(id: string) {
  return id.replace(/^gpt-/, 'GPT-').replace(/-(sol|luna|astra)$/, (_, name: string) => ` ${name[0]?.toUpperCase()}${name.slice(1)}`);
}
function latestModels(models: z.infer<typeof modelSchema>[]) {
  return ['sol','astra','luna'].flatMap(family => {
    const versions = models.filter(model => new RegExp(`^gpt-\\d+(?:\\.\\d+)*-${family}$`).test(model.id));
    versions.sort((left,right) => right.id.localeCompare(left.id,undefined,{numeric:true}));
    return versions.slice(0,1);
  });
}
export function ModelMenu({ target = 'chat',chatId = null }: { target?:'chat'|'grading'|'default';chatId?:string|null }) {
  const { state, act,draftModelSelection,selectModel } = useApp();
  const conversation = state.chats.find(chat => chat.id === chatId)?.modelSelection ?? (chatId ? null : draftModelSelection);
  const modelId = target === 'grading' ? state.settings.gradingModel : target === 'chat' ? conversation?.model ?? state.settings.chatModel : state.settings.chatModel;
  const savedEffort = target === 'grading' ? state.settings.gradingReasoningEffort : target === 'chat' ? conversation?.effort ?? state.settings.reasoningEffort : state.settings.reasoningEffort;
  const sliderId = useId();
  const save = (model: string,effort: typeof state.settings.reasoningEffort) => target === 'chat' ? selectModel(chatId,{model,effort}) : api.saveSettings(target === 'grading' ? { gradingModel:model,gradingReasoningEffort:effort } : { chatModel:model,reasoningEffort:effort });
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<z.infer<typeof modelSchema>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = models.find(item => item.id === modelId);
  const choices = latestModels(models);
  const efforts = (selected?.reasoningEfforts ?? []).filter(effort => effort !== 'max' && effort !== 'ultra');
  const [draftEffort,setDraftEffort] = useState(savedEffort);
  useEffect(() => { setDraftEffort(savedEffort); },[savedEffort]);
  const effortIndex = Math.max(0,efforts.findIndex(effort => effort === draftEffort));
  const effortLabel = (effort: string) => effort === 'xhigh' ? 'Extra high' : effort[0]?.toUpperCase() + effort.slice(1);
  async function saveEffort(index: number) {
    const effort = efforts[index];
    if (pending.current || !effort || effort === savedEffort) return;
    pending.current = true;
    setSaving(true);
    try {
      const saved = await act(() => save(modelId,effort));
      if (saved === undefined) setDraftEffort(savedEffort);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  async function load() {
    setLoading(true); setError('');
    try { setModels((await api.models()).models); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Models unavailable'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!open) return;
    if (!models.length) void load();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function select(model: z.infer<typeof modelSchema>) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    const allowed = model.reasoningEfforts.filter(effort => effort !== 'max' && effort !== 'ultra');
    const saved = await act(() => save(model.id,allowed.some(effort => effort === savedEffort) ? savedEffort : allowed.some(effort => effort === model.defaultReasoningEffort) ? model.defaultReasoningEffort : allowed[0] ?? 'medium'));
    pending.current = false;
    setSaving(false);
    if (saved) setOpen(false);
  }
  return <div className="model-picker" ref={root}>
    <button ref={trigger} type="button" className="model-picker__trigger" aria-label={target === 'grading' ? 'Choose marking model' : 'Choose model'} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {modelLabel(modelId)}<span className="composer__effort">{savedEffort === 'xhigh' ? 'Extra high' : savedEffort}</span><ChevronDown size={11} />
    </button>
    {open ? <div className="model-picker__panel" aria-label="Model and reasoning">
      <div className="model-picker__heading">{target === 'chat' ? 'This chat' : target === 'default' ? 'Default for new chats' : 'Marking model'} {loading ? <span className="spinner spinner--small" /> : null}</div>
      <div className="model-picker__models" role="menu" aria-label="Available models">
        {choices.map(model => <button type="button" role="menuitemradio" aria-checked={model.id === modelId} className="model-picker__model" key={model.id} disabled={saving} onClick={() => void select(model)}><span>{modelLabel(model.id)}</span>{model.id === modelId ? <Check size={13} /> : null}</button>)}
      </div>
      {error ? <div className="model-picker__error"><span title={error}>Couldn’t load models</span><button type="button" aria-label="Retry loading models" title={error} onClick={() => void load()}><RotateCw size={13} /></button></div> : null}
      {selected && efforts.length ? <div className="model-picker__reasoning"><label htmlFor={sliderId}>Reasoning <span>{effortLabel(efforts[effortIndex] ?? 'medium')}</span></label><input id={sliderId} type="range" min={0} max={efforts.length-1} step={1} style={{backgroundImage:`linear-gradient(to right,#8ea6e8 ${efforts.length > 1 ? effortIndex/(efforts.length-1)*100 : 0}%,var(--line-strong) 0%)`}} value={effortIndex} disabled={saving} aria-label={target === 'grading' ? 'Marking reasoning effort' : 'Reasoning effort'} aria-valuetext={effortLabel(efforts[effortIndex] ?? 'medium')} onChange={event => { const effort = efforts[Number(event.target.value)]; if (effort) setDraftEffort(effort); }} onPointerUp={event => saveEffort(Number(event.currentTarget.value))} onBlur={event => saveEffort(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) saveEffort(Number(event.currentTarget.value)); }} /><div className="model-picker__stops">{efforts.map(effort => <button type="button" key={effort} disabled={saving} onClick={() => { setDraftEffort(effort); saveEffort(efforts.indexOf(effort)); }}>{effortLabel(effort)}</button>)}</div></div> : null}
    </div> : null}
  </div>;
}

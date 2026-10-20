import { useId, useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { timeAgo } from './format';

type Memory = Snapshot['assistantMemories'][number];
type MemoryAction = { kind:'edit'; memory:Memory } | { kind:'forget'; memory:Memory };

function MemoryEditor({ memory, onClose }: { memory:Memory; onClose:() => void }) {
  const { act } = useApp();
  const [content,setContent] = useState(memory.content);
  const [saving,setSaving] = useState(false);
  const fieldId = useId();
  const formId = useId();

  async function save(event:FormEvent) {
    event.preventDefault();
    if (!content.trim() || saving) return;
    setSaving(true);
    const saved = await act(() => api.updateMemory(memory.id,content.trim()),'Memory saved');
    setSaving(false);
    if (saved) onClose();
  }

  return <Dialog title="Edit memory" description="Update what Centre remembers about you. Your changes carry across chats and app restarts." onClose={onClose} dismissible={!saving} footer={<>
    <button type="button" className="button button--quiet button--small" onClick={onClose} disabled={saving}>Cancel</button>
    <button type="submit" form={formId} className="button button--primary button--small" disabled={saving || !content.trim() || content.trim() === memory.content}>{saving ? 'Saving' : 'Save changes'}</button>
  </>}>
    <form id={formId} className="form" onSubmit={event => void save(event)}>
      <label className="field" htmlFor={fieldId}><span className="field__label">What Centre knows</span>
        <textarea id={fieldId} value={content} onChange={event => setContent(event.target.value)} rows={5} maxLength={1000} required disabled={saving} aria-describedby={`${fieldId}-count`} />
      </label>
      <p id={`${fieldId}-count`} className="preference-note">{content.length} / 1,000 characters</p>
    </form>
  </Dialog>;
}

function ForgetMemory({ memory, onClose }: { memory:Memory; onClose:() => void }) {
  const { act } = useApp();
  const [busy,setBusy] = useState(false);
  async function forget() {
    setBusy(true);
    const result = await act(() => api.forgetMemory(memory.id),'Memory forgotten');
    setBusy(false);
    if (result) onClose();
  }
  return <Dialog title="Forget this memory?" description="Centre will stop using this saved fact in future responses. Existing chat messages will stay in your history." onClose={onClose} dismissible={!busy} footer={<>
    <button type="button" className="button button--quiet button--small" onClick={onClose} disabled={busy}>Cancel</button>
    <button type="button" className="button button--small" onClick={() => void forget()} disabled={busy}>{busy ? 'Forgetting' : 'Forget memory'}</button>
  </>}><p className="memory-settings__fact">{memory.content}</p></Dialog>;
}

export function MemorySettings() {
  const { state } = useApp();
  const [action,setAction] = useState<MemoryAction | null>(null);
  const memories = state.assistantMemories;
  return <>
    <p className="preferences-description memory-settings__intro">Centre remembers facts, learning preferences and goals you share in chat. These are saved on this computer and used across chats, even after you restart the app.</p>
    <div className="memory-settings__heading"><h2 className="preferences-title">What Centre knows about you</h2><span className="preference-note">{memories.length} / 50 memories</span></div>
    {memories.length ? <ul className="memory-settings__list">{memories.map(memory => <li key={memory.id} className="memory-settings__item">
      <div className="memory-settings__text"><p className="memory-settings__fact">{memory.content}</p><p className="preference-note"><time dateTime={memory.updatedAt} title={new Date(memory.updatedAt).toLocaleString()}>Updated {timeAgo(memory.updatedAt)}</time></p></div>
      <div className="memory-settings__actions"><button type="button" className="button button--quiet button--small" onClick={() => setAction({ kind:'edit',memory })}>Edit</button><button type="button" className="button button--quiet button--small" onClick={() => setAction({ kind:'forget',memory })}>Forget</button></div>
    </li>)}</ul> : <div className="memory-settings__empty"><p>No saved memories yet</p><p className="preferences-description">Tell Centre something like "Remember that I learn best with worked examples" in a chat. It will appear here.</p></div>}
    {action?.kind === 'edit' ? <MemoryEditor memory={action.memory} onClose={() => setAction(null)} /> : null}
    {action?.kind === 'forget' ? <ForgetMemory memory={action.memory} onClose={() => setAction(null)} /> : null}
  </>;
}

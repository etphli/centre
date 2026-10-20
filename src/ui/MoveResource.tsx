import { useState } from 'react';
import type { Resource } from '../../shared/schema';
import { api } from '../data/client';
import { Dialog } from './Dialog';
import { Select } from './Select';
import { useApp } from './context';
import { errorMessage } from './format';

export function MoveResource({resource,onClose}:{resource:Resource;onClose:()=>void}) {
  const {state,act} = useApp();
  const [subjectId,setSubject] = useState(resource.subjectId);
  const [topicId,setTopic] = useState(resource.topicId);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const topics = state.topics.filter(topic => topic.subjectId === subjectId);
  async function move() {
    setBusy(true);setError('');
    try {
      const result = await act(() => api.moveResource(resource.id,{subjectId,topicId}),'Resource moved');
      if (result) onClose();
    } catch(failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Dialog title="Move resource" description={resource.title} size="sm" onClose={onClose} dismissible={!busy} footer={<><button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="button button--primary" disabled={busy || !topicId} onClick={() => void move()}>{busy ? 'Moving' : 'Move'}</button></>}>
    <div className="form"><label>Subject<Select label="Move to subject" value={subjectId} options={state.subjects.map(subject => ({value:subject.id,label:subject.name}))} onChange={value => {setSubject(value);setTopic(state.topics.find(topic => topic.subjectId === value)?.id ?? '');}} /></label>
    <label>Topic<Select label="Move to topic" value={topicId} options={topics.map(topic => ({value:topic.id,label:topic.name}))} onChange={setTopic} /></label>
    {!topics.length ? <p className="muted">Create a topic in this subject first.</p> : null}{error ? <p className="form__error" role="alert">{error}</p> : null}</div>
  </Dialog>;
}

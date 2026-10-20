import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Resource } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { Dialog } from './Dialog';

export function DeleteResource({ resource,compact = false,onDeleted }: {resource:Resource;compact?:boolean;onDeleted?:() => void}) {
  const { act,notify } = useApp();
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const submitting = useRef(false);
  async function remove() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    try {
      const result = await act(() => api.deleteResource(resource.id));
      if (!result) return;
      setOpen(false);
      notify({tone:'success',message:'Resource deleted',action:{label:'Undo',run:() => { void act(() => api.restoreResource(resource.id),'Resource restored'); }}});
      onDeleted?.();
    } finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className={compact ? 'resource-card__peek' : 'button button--quiet button--small'} aria-label={`Delete ${resource.title}`} title="Delete resource" onClick={() => setOpen(true)}><Trash2 size={14} />{!compact ? 'Delete' : null}</button>
    {open ? <Dialog title="Delete resource?" description={resource.title} onClose={() => setOpen(false)} dismissible={!busy} size="sm" footer={<><button type="button" className="button button--quiet" disabled={busy} onClick={() => setOpen(false)}>Keep resource</button><button type="button" className="button button--primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete resource'}</button></>}><p>This removes the resource and its review items from your library. You can undo after deleting.</p></Dialog> : null}
  </>;
}

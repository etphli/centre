import { FileText, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../../shared/schema';
import { api, chooseAttachmentFiles } from '../data/client';

const metadata = new Map<string,Promise<Attachment>>();
const sizeLabel = (size:number) => size < 1024*1024 ? `${Math.max(1,Math.round(size/1024))} KB` : `${(size/(1024*1024)).toFixed(1)} MB`;
function filePayload(file:File):Promise<{name:string;mimeType:string;data:string}> {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`));
    reader.onload = () => { if (typeof reader.result !== 'string') { reject(new Error('File could not be read.')); return; } resolve({name:file.name,mimeType:file.type,data:reader.result.slice(reader.result.indexOf(',')+1)}); };
    reader.readAsDataURL(file);
  });
}

export function useComposerAttachments() {
  const [files,setFiles] = useState<Attachment[]>([]);
  const [uploading,setUploading] = useState(false);
  const [error,setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  async function upload(payloads:{name:string;mimeType:string;data:string}[]) {
    for (const file of payloads) {
      const attachment = await api.uploadAttachment(file);
      metadata.set(attachment.id,Promise.resolve(attachment));
      setFiles(current => [...current,attachment]);
    }
  }
  async function addFiles(incoming:File[]) {
    if (adding.current) return;
    if (incoming.some(file => file.size > 20*1024*1024)) { setError('Each file must be 20 MB or smaller.'); return; }
    adding.current = true; setUploading(true); setError('');
    try { for (const file of incoming) await upload([await filePayload(file)]); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The file could not be attached.'); }
    finally { adding.current = false; setUploading(false); }
  }
  async function pick() {
    if (!window.centre) { input.current?.click(); return; }
    if (adding.current) return;
    adding.current = true; setUploading(true); setError('');
    try {
      const payloads = await chooseAttachmentFiles();
      await upload(payloads);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The file could not be attached.'); }
    finally { adding.current = false; setUploading(false); }
  }
  const picker = <input type="file" ref={input} multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.htm,.tex,.png,.jpg,.jpeg,.webp,.js,.ts,.py,.css" onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void addFiles(selected); }} />;
  const chips = files.length || uploading ? <div className="composer-files">{files.map(file => <span className="composer-file" key={file.id}><FileText size={13} /><span title={`${file.name}, ${sizeLabel(file.size)}`}>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(item => item.id !== file.id))}><X size={11} /></button></span>)}{uploading ? <span className="composer-file"><span className="spinner spinner--small" /> Adding files</span> : null}</div> : null;
  async function restore(ids:string[]) {
    const restored = await Promise.allSettled(ids.map(id => api.getAttachment(id)));
    setFiles(current => [...current,...restored.flatMap(result => result.status === 'fulfilled' && !current.some(file => file.id === result.value.id) ? [result.value] : [])]);
  }
  return { files,uploading,error,setError,picker,chips,pick,addFiles,restore,clear:()=>setFiles([]) };
}

export function AttachmentButton({ onClick,disabled }: {onClick:()=>void;disabled:boolean}) {
  return <button type="button" className="icon-button composer__attach" aria-label="Attach files" title="Attach files" onClick={onClick} disabled={disabled}><Paperclip size={16} /></button>;
}

export function MessageAttachments({ ids }: {ids:string[]}) {
  const [files,setFiles] = useState<Attachment[]>([]);
  useEffect(() => {
    let live = true;
    const work = ids.map(id => { const saved = metadata.get(id); if (saved) return saved; const pending = api.getAttachment(id); metadata.set(id,pending); pending.catch(() => metadata.delete(id)); return pending; });
    void Promise.allSettled(work).then(results => { if (live) setFiles(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])); });
    return () => { live = false; };
  },[ids]);
  if (!ids.length) return null;
  return <div className="message-files" aria-label="Attached files">{files.map(file => <span className="message-file" key={file.id}><FileText size={14} /><span>{file.name}<small>{sizeLabel(file.size)}</small></span></span>)}</div>;
}

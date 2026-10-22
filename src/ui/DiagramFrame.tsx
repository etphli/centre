import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Resource } from '../../shared/schema';
import { validateChecklistBridgeMessage } from '../../shared/checklist-progress';
import { ChecklistProgressQueue, type ChecklistSaveStatus } from '../../shared/checklist-progress-queue';
import { api, openDiagramFile } from '../data/client';
import { useApp } from './context';
import { errorMessage } from './format';
import { ExternalLink } from 'lucide-react';
import './diagram.css';

type ReadyPreview = { status:'ready';url:string;documentRevision:string;itemIds:string[];checkedItemIds:string[];hasProgress:boolean };
type Preview = { status:'loading' } | ReadyPreview | { status:'error';message:string };
type ChecklistScope = Omit<ReadyPreview,'status'|'url'> & {resourceId:string};
const progressQueue = new ChecklistProgressQueue((scope,itemId,checked) => api.saveChecklistProgress(scope.resourceId,scope.documentRevision,itemId,checked));
const diagramSizeMessageSchema = z.object({type:z.literal('centre:diagram-size'),height:z.number().finite().min(0).max(100_000)}).strict();

function frameTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const theme = root.dataset.theme === 'light' ? 'light' : root.dataset.theme === 'midnight' ? 'midnight' : 'dark';
  const names = ['bg','surface','surface-2','text','text-2','line','accent'];
  return { type:'centre:theme',theme,colors:Object.fromEntries(names.map(name => [name,style.getPropertyValue(`--${name}`).trim()])) };
}

export function DiagramFrame({ resource, thumbnail = false }: { resource:Resource;thumbnail?:boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const scope = useRef<ChecklistScope|null>(null);
  const allowedItems = useRef<ReadonlySet<string>>(new Set());
  const checkedItems = useRef<Set<string>>(new Set());
  const [preview,setPreview] = useState<Preview>({status:'loading'});
  const [height,setHeight] = useState(420);
  const [saveState,setSaveState] = useState<ChecklistSaveStatus>('idle');
  useEffect(() => {
    let live = true;
    let unsubscribe = () => {};
    scope.current = null;
    allowedItems.current = new Set();
    checkedItems.current = new Set();
    setSaveState('idle');
    setPreview({status:'loading'});
    progressQueue.read(resource.id,() => api.previewResource(resource.id)).then(({url,documentRevision,itemIds,checkedItemIds,hasProgress}) => {
      const themed = new URL(url); themed.searchParams.set('theme',frameTheme().theme);
      if (live) {
        const nextScope = {resourceId:resource.id,documentRevision,itemIds,checkedItemIds,hasProgress};
        scope.current = nextScope;
        allowedItems.current = new Set(itemIds);
        checkedItems.current = new Set(checkedItemIds);
        const pending = progressQueue.pending(nextScope);
        for (const [itemId,checked] of pending) if (allowedItems.current.has(itemId)) {
          if (checked) checkedItems.current.add(itemId);else checkedItems.current.delete(itemId);
        }
        if (pending.size) nextScope.hasProgress = true;
        if (!thumbnail) unsubscribe = progressQueue.subscribe(nextScope,event => {
          if (!live || scope.current !== nextScope) return;
          if (event.type === 'status') setSaveState(event.status);
          else if (allowedItems.current.has(event.itemId)) {
            if (event.checked) checkedItems.current.add(event.itemId);else checkedItems.current.delete(event.itemId);
            nextScope.hasProgress = true;
            frame.current?.contentWindow?.postMessage({type:'centre:checklist-restore',resourceId:resource.id,documentRevision,hasProgress:true,checkedItemIds:[...checkedItems.current]},'*');
          }
        });
        setPreview({status:'ready',url:themed.href,...nextScope});
      }
    },(failure:unknown) => { if (live) setPreview({status:'error',message:errorMessage(failure)}); });
    return () => { live = false;scope.current = null;unsubscribe(); };
  },[resource.id,resource.updatedAt,resource.content,thumbnail]);
  useEffect(() => {
    const sendTheme = () => frame.current?.contentWindow?.postMessage(frameTheme(),'*');
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    function received(event:MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow) return;
      const current = scope.current;
      if (current) {
        const message = validateChecklistBridgeMessage(event.source,frame.current?.contentWindow,event.data,resource.id,current.documentRevision,allowedItems.current);
        if (message?.type === 'ready') {
          frame.current?.contentWindow?.postMessage({type:'centre:checklist-restore',resourceId:current.resourceId,documentRevision:current.documentRevision,hasProgress:current.hasProgress,checkedItemIds:[...checkedItems.current]},'*');
        } else if (!thumbnail && message?.type === 'change') {
          progressQueue.enqueue(current,message.itemId,message.checked);
        }
      }
      const size = diagramSizeMessageSchema.safeParse(event.data);
      if (size.success && !thumbnail) {
        setHeight(Math.max(200,Math.min(2200,size.data.height + 2)));
      }
    }
    window.addEventListener('message',received);
    sendTheme();
    return () => { observer.disconnect();window.removeEventListener('message',received); };
  },[resource.id,thumbnail]);
  if (!resource.content.trim()) return <p className="preview-empty">The diagram is empty.</p>;
  if (preview.status === 'error') return <p className="preview-empty" role={thumbnail ? undefined : 'alert'}>{thumbnail ? 'Preview unavailable' : `The diagram couldn’t load. ${preview.message}`}</p>;
  if (preview.status === 'loading') return <p className="preview-empty" role={thumbnail ? undefined : 'status'}><span className="spinner spinner--small" aria-hidden /> Loading diagram</p>;
  return <>
    <iframe ref={frame} className={thumbnail ? 'card-preview__frame' : 'diagram-embed'} title={thumbnail ? '' : resource.title} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={thumbnail ? -1 : undefined} src={preview.url} style={thumbnail ? undefined : {height}} onLoad={() => frame.current?.contentWindow?.postMessage(frameTheme(),'*')} />
    {!thumbnail && preview.itemIds.length ? <div className="diagram-progress">
      {saveState === 'saving' ? <span role="status">Saving checklist progress…</span> : null}
      {saveState === 'saved' ? <span role="status">Checklist progress saved.</span> : null}
      {saveState === 'error' ? <><span role="alert">Checklist progress wasn’t saved. Retry before leaving this page.</span><button type="button" onClick={() => { if (scope.current) progressQueue.retry(scope.current); }}>Retry save</button></> : null}
    </div> : null}
  </>;
}

export function OpenDiagramButton({resource,compact=false}:{resource:Resource;compact?:boolean}) {
  const {notify} = useApp();
  const [busy,setBusy] = useState(false);
  return <button type="button" className={compact ? 'link-button' : 'button button--quiet button--small'} disabled={busy} onClick={async () => {
    setBusy(true);
    try { await openDiagramFile(resource.id,frameTheme().theme); }
    catch(failure) { notify({tone:'error',message:errorMessage(failure)}); }
    finally { setBusy(false); }
  }}><ExternalLink size={13} />{busy ? 'Opening' : 'Open file'}</button>;
}

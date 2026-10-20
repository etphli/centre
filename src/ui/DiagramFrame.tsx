import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Resource } from '../../shared/schema';
import { api, openDiagramFile } from '../data/client';
import { useApp } from './context';
import { errorMessage } from './format';
import { ExternalLink } from 'lucide-react';
import './diagram.css';

type Preview = { status:'loading' } | { status:'ready';url:string } | { status:'error';message:string };
const sizeMessage = z.object({ type:z.literal('centre:diagram-size'),height:z.number().finite().min(0).max(100_000) });

function frameTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const theme = root.dataset.theme === 'light' ? 'light' : root.dataset.theme === 'midnight' ? 'midnight' : 'dark';
  const names = ['bg','surface','surface-2','text','text-2','line','accent'];
  return { type:'centre:theme',theme,colors:Object.fromEntries(names.map(name => [name,style.getPropertyValue(`--${name}`).trim()])) };
}

export function DiagramFrame({ resource, thumbnail = false }: { resource:Resource;thumbnail?:boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [preview,setPreview] = useState<Preview>({status:'loading'});
  const [height,setHeight] = useState(420);
  useEffect(() => {
    let live = true;
    setPreview({status:'loading'});
    api.previewResource(resource.id).then(({url}) => {
      const themed = new URL(url); themed.searchParams.set('theme',frameTheme().theme);
      if (live) setPreview({status:'ready',url:themed.href});
    },(failure:unknown) => { if (live) setPreview({status:'error',message:errorMessage(failure)}); });
    return () => { live = false; };
  },[resource.id,resource.updatedAt]);
  useEffect(() => {
    const sendTheme = () => frame.current?.contentWindow?.postMessage(frameTheme(),'*');
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    function resized(event:MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow || thumbnail) return;
      const message = sizeMessage.safeParse(event.data);
      if (message.success) setHeight(Math.max(200,Math.min(2200,message.data.height + 2)));
    }
    window.addEventListener('message',resized);
    sendTheme();
    return () => { observer.disconnect();window.removeEventListener('message',resized); };
  },[thumbnail]);
  if (!resource.content.trim()) return <p className="preview-empty">The diagram is empty.</p>;
  if (preview.status === 'error') return <p className="preview-empty" role={thumbnail ? undefined : 'alert'}>{thumbnail ? 'Preview unavailable' : `The diagram couldn’t load. ${preview.message}`}</p>;
  if (preview.status === 'loading') return <p className="preview-empty" role={thumbnail ? undefined : 'status'}><span className="spinner spinner--small" aria-hidden /> Loading diagram</p>;
  return <iframe ref={frame} className={thumbnail ? 'card-preview__frame' : 'diagram-embed'} title={thumbnail ? '' : resource.title} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={thumbnail ? -1 : undefined} src={preview.url} style={thumbnail ? undefined : {height}} onLoad={() => frame.current?.contentWindow?.postMessage(frameTheme(),'*')} />;
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

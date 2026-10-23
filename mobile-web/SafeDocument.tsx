import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { prepareChecklistContent } from '../server/diagram';
import { interactiveResourceProgressId, interactiveResourceProgressSchema } from '../shared/checklist-progress';
import type { Resource } from '../shared/schema';
import type { MobileModel } from './model';
import type { MobileState } from './data/store';
import { records } from './domain';
import { ErrorLine, useAction } from './ui';
const htmlTags=new Set(['div','section','article','header','footer','main','span','p','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','b','em','i','u','s','br','hr','table','thead','tbody','tr','td','th','caption','blockquote','pre','code','label','details','summary','dl','dt','dd','sup','sub']);
const svgTags=new Set(['svg','g','path','line','circle','rect','ellipse','polyline','polygon','text','tspan','title','desc']);
const svgAttrs=new Map([['viewBox','viewBox'],['viewbox','viewBox'],['d','d'],['x','x'],['y','y'],['x1','x1'],['x2','x2'],['y1','y1'],['y2','y2'],['cx','cx'],['cy','cy'],['r','r'],['rx','rx'],['ry','ry'],['width','width'],['height','height'],['points','points'],['fill','fill'],['stroke','stroke'],['stroke-width','strokeWidth'],['text-anchor','textAnchor'],['transform','transform'],['opacity','opacity'],['font-size','fontSize']]);
export function SafeDocument({resource,state,model}:{resource:Resource;state:MobileState;model:MobileModel}) {
  const prepared=useMemo(()=>prepareChecklistContent(resource.content),[resource.content]);
  const tree=useMemo(()=>parseFragment(prepared.content),[prepared.content]);
  const [optimistic,setOptimistic]=useState<Record<string,boolean>>({});
  const [identity,setIdentity]=useState<{id:string;revision:string}|null>(null),action=useAction();
  useEffect(()=>{let live=true;void crypto.subtle.digest('SHA-256',new TextEncoder().encode(resource.content)).then(async digest=>{const revision=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');const id=await interactiveResourceProgressId(resource.id,revision);if(live)setIdentity({id,revision});});return()=>{live=false;};},[resource.content,resource.id]);
  const progress=records(state.entities,'interactiveProgress',interactiveResourceProgressSchema).find(item=>item.id===identity?.id&&!item.deletedAt);
  const checked=new Set(progress?.checkedItemIds??prepared.checkedItemIds);
  for(const [id,value]of Object.entries(optimistic)){if(value)checked.add(id);else checked.delete(id);}
  const allowed=new Set(prepared.itemIds);
  let budget=5000;
  function render(node:DefaultTreeAdapterTypes.Node,key:string):ReactNode {
    if(--budget<0)return null;
    if(node.nodeName==='#text'&&'value'in node)return node.value;
    if(!('tagName'in node))return null;
    const tag=node.tagName;
    if(['script','style','template','iframe','object','embed','form','meta','link','img','video','audio','foreignObject'].includes(tag))return null;
    const attr=(name:string)=>node.attrs.find(item=>item.name===name)?.value;
    if(tag==='input'&&attr('type')?.toLowerCase()==='checkbox'){
      const id=attr('data-centre-checklist-id');
      if(!id||!allowed.has(id))return null;
      return <input key={key} type="checkbox" checked={checked.has(id)} aria-label={attr('aria-label')??`Checklist item ${prepared.itemIds.indexOf(id)+1}`} disabled={!identity||action.busy} onChange={event=>{const value=event.target.checked;setOptimistic(current=>({...current,[id]:value}));void action.run(()=>model.serial(async()=>{if(!identity)return;const existing=records(model.store.getSnapshot().entities,'interactiveProgress',interactiveResourceProgressSchema).find(item=>item.id===identity.id);const next=new Set(existing?.checkedItemIds??prepared.checkedItemIds);if(value)next.add(id);else next.delete(id);const stamp=new Date().toISOString();await model.store.save('interactiveProgress',identity.id,interactiveResourceProgressSchema.parse({schemaVersion:1,id:identity.id,revision:(existing?.revision??0)+1,resourceId:resource.id,documentRevision:identity.revision,checkedItemIds:[...next].sort(),createdAt:existing?.createdAt??stamp,updatedAt:stamp,deletedAt:null}));})).finally(()=>setOptimistic(current=>{const next={...current};delete next[id];return next;}));}}/>;
    }
    const children=node.childNodes.map((child,index)=>render(child,`${key}.${index}`));
    if(tag==='a'){
      const href=attr('href');return href&&/^https?:\/\//i.test(href)?<a key={key} href={href} rel="noreferrer" target="_blank">{children}</a>:<span key={key}>{children}</span>;
    }
    if(svgTags.has(tag)){
      const props:Record<string,string|number>={key};
      for(const attribute of node.attrs){const name=svgAttrs.get(attribute.name);if(name&&attribute.value.length<=10000&&!/url\s*\(|javascript:|data:/i.test(attribute.value))props[name]=attribute.value;}
      return createElement(tag,props,children);
    }
    return htmlTags.has(tag)?createElement(tag,{key},children):<span key={key}>{children}</span>;
  }
  return <><p className="detail">Reading view. Checklists save across your devices. Animations and custom interactions open on your Mac.</p><div className="safe-document prose">{tree.childNodes.map((node,index)=>render(node,String(index)))}</div><ErrorLine error={action.error}/>{action.busy||progress?<p className="detail" role="status">{action.busy?'Saving checklist…':'Checklist saved on this device'}</p>:null}</>;
}

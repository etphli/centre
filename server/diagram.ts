import { parse, parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';
import { explicitChecklistItemIdSchema } from '../shared/checklist-progress';

export type DiagramTheme = 'dark' | 'light' | 'midnight';

const palettes = {
  dark: { bg:'#1b1b1a',surface:'#20201f','surface-2':'#262625',text:'#ecebe7','text-2':'#a8a7a1',line:'#2d2d2b','line-strong':'#3b3b38',accent:'#8ea6e8' },
  light: { bg:'#f9f9f7',surface:'#ffffff','surface-2':'#f3f3f0',text:'#131313','text-2':'#7b7974',line:'#e4e4e1','line-strong':'#d8d8d5',accent:'#2a78d6' },
  midnight: { bg:'#101114',surface:'#18191e','surface-2':'#202126',text:'#e8e9ec','text-2':'#a1a3ac',line:'#25272c','line-strong':'#36383f',accent:'#8ea6e8' },
} satisfies Record<DiagramTheme, Record<string,string>>;

export function diagramTheme(value: string | null): DiagramTheme | undefined {
  return value === 'light' || value === 'dark' || value === 'midnight' ? value : undefined;
}

export const diagramCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'";
export const diagramArtifactCsp = `${diagramCsp}; frame-src 'none'`;

const scriptJson = (value:unknown) => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');

function cleanDiagramContent(html:string) {
  const document = parse(html);
  function clean(parent:DefaultTreeAdapterTypes.ParentNode) {
    let bridge = false;
    parent.childNodes = parent.childNodes.filter(node => {
      if (node.nodeName === '#comment' && 'data' in node && node.data === 'centre:bridge') { bridge = true; return false; }
      if (node.nodeName === '#comment' && 'data' in node && node.data === '/centre:bridge') { bridge = false; return false; }
      return !bridge && !('tagName' in node && node.tagName === 'meta');
    });
    for (const node of parent.childNodes) if ('childNodes' in node) clean(node);
  }
  clean(document);
  const root = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html');
  if (!root || !('childNodes' in root)) return '';
  return root.childNodes.flatMap(node => 'tagName' in node && (node.tagName === 'head' || node.tagName === 'body') ? node.childNodes : [node])
    .map(node => serializeOuter(node)).join('');
}

function checkboxElements(content:string) {
  const elements:DefaultTreeAdapterTypes.Element[] = [];
  function visit(node:DefaultTreeAdapterTypes.Node) {
    if ('tagName' in node && node.tagName === 'template') return;
    if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.tagName === 'input'
      && node.attrs.find(attribute => attribute.name === 'type')?.value.toLowerCase() === 'checkbox') elements.push(node);
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(content,{sourceCodeLocationInfo:true}));
  return elements.slice(0,100);
}

export function prepareChecklistContent(html:string) {
  const content = cleanDiagramContent(html);
  const elements = checkboxElements(content);
  const explicitIds = elements.map(element => element.attrs.find(attribute => attribute.name === 'data-centre-checklist-id')?.value ?? null);
  const counts = new Map<string,number>();
  explicitIds.forEach(id => { if (id && explicitChecklistItemIdSchema.safeParse(id).success) counts.set(id,(counts.get(id) ?? 0) + 1); });
  const itemIds:string[] = [];
  const checkedItemIds:string[] = [];
  const insertions:Array<{at:number;value:string}> = [];
  elements.forEach((element,index) => {
    const explicit = explicitIds[index];
    const itemId = explicit && explicitChecklistItemIdSchema.safeParse(explicit).success && counts.get(explicit) === 1 ? explicit : `legacy-${index + 1}`;
    itemIds.push(itemId);
    if (element.attrs.some(attribute => attribute.name === 'checked')) checkedItemIds.push(itemId);
    if (explicit === itemId) return;
    const start = element.sourceCodeLocation?.startTag?.startOffset;
    if (start !== undefined) insertions.push({at:start + '<input'.length,value:` data-centre-checklist-id="${itemId}"`});
  });
  let annotated = content;
  for (const insertion of insertions.sort((a,b) => b.at - a.at)) annotated = `${annotated.slice(0,insertion.at)}${insertion.value}${annotated.slice(insertion.at)}`;
  return {content:annotated,itemIds,checkedItemIds};
}

export type ChecklistBridgeScope = { resourceId:string;documentRevision:string };

function checklistBridge(scope:ChecklistBridgeScope,itemIds:string[]) {
  return `<script>
(()=>{
  const scope=${scriptJson(scope)}, itemIds=${scriptJson(itemIds)}, allowed=new Set(itemIds), elements=new Map();
  for(const input of document.querySelectorAll('input[type="checkbox"][data-centre-checklist-id]')){
    const id=input.getAttribute('data-centre-checklist-id');if(allowed.has(id)&&!elements.has(id))elements.set(id,input);
  }
  let restoring=false;
  addEventListener('message',event=>{
    if(event.source!==parent)return;
    const data=event.data;
    if(data?.type==='centre:checklist-probe'&&Object.keys(data).sort().join(',')==='documentRevision,nonce,resourceId,type'&&data.resourceId===scope.resourceId&&data.documentRevision===scope.documentRevision&&typeof data.nonce==='string'&&/^[a-f0-9]{32}$/.test(data.nonce)){parent.postMessage({type:'centre:checklist-alive',...scope,nonce:data.nonce},'*');return}
    if(!data||data.type!=='centre:checklist-restore'||data.resourceId!==scope.resourceId||data.documentRevision!==scope.documentRevision||data.hasProgress!==true||!Array.isArray(data.checkedItemIds)||data.checkedItemIds.length>itemIds.length)return;
    const checked=new Set();for(const id of data.checkedItemIds){if(typeof id!=='string'||!allowed.has(id)||checked.has(id))return;checked.add(id)}
    const keys=Object.keys(data).sort().join(',');if(keys!=='checkedItemIds,documentRevision,hasProgress,resourceId,type')return;
    restoring=true;for(const id of itemIds){const input=elements.get(id);if(input)input.checked=checked.has(id)}restoring=false;
  });
  document.addEventListener('change',event=>{
    if(restoring||!event.isTrusted)return;const input=event.target;if(!(input instanceof HTMLInputElement))return;
    for(const [itemId,element] of elements){if(element===input){parent.postMessage({type:'centre:checklist-change',resourceId:scope.resourceId,documentRevision:scope.documentRevision,itemId,checked:input.checked},'*');return}}
  },true);
  parent.postMessage({type:'centre:checklist-ready',resourceId:scope.resourceId,documentRevision:scope.documentRevision},'*');
})();
</script>`;
}

export function diagramDocument(html: string, theme?: DiagramTheme, checklistScope?:ChecklistBridgeScope): string {
  const prepared = prepareChecklistContent(html);
  const content = prepared.content;
  const aware = /var\(\s*--(?:centre-|bg\b|surface\b|text\b|accent\b)/.test(content);
  const initial = theme ?? 'dark';
  const css = Object.entries(palettes[initial]).map(([name,value]) => `--centre-${name}:${value}`).join(';');
  const checklistScript = checklistScope ? checklistBridge(checklistScope,prepared.itemIds) : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${diagramCsp}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}
<!--centre:bridge--><style>
:root{${css};--bg:var(--centre-bg);--surface:var(--centre-surface);--surface-2:var(--centre-surface-2);--text:var(--centre-text);--text-2:var(--centre-text-2);--line:var(--centre-line);--accent:var(--centre-accent);color-scheme:${initial === 'light' ? 'light' : 'dark'}!important}
html,body{margin:0!important;min-height:0!important;height:auto!important;background:var(--centre-bg)!important;color:var(--centre-text)!important}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}
*,*::before,*::after{box-sizing:border-box}img,svg,canvas{max-width:100%}input,button,select,textarea{accent-color:var(--centre-accent)}
input[type=checkbox][data-centre-checklist-id]{appearance:none!important;-webkit-appearance:none!important;display:inline-grid;place-content:center;flex:0 0 auto;width:16px;height:16px;margin:0;border:1px solid var(--centre-line-strong)!important;border-radius:3px;background:var(--centre-surface)!important;color:var(--centre-bg)!important;vertical-align:middle;cursor:pointer}
input[type=checkbox][data-centre-checklist-id]::after{content:"";display:block;width:8px;height:5px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-1px) rotate(-45deg);opacity:0}
input[type=checkbox][data-centre-checklist-id]:checked{background:var(--centre-text)!important;border-color:var(--centre-text)!important}
input[type=checkbox][data-centre-checklist-id]:checked::after{opacity:1}
input[type=checkbox][data-centre-checklist-id]:not(:checked):not(:disabled):hover{border-color:var(--centre-text-2)!important}
input[type=checkbox][data-centre-checklist-id]:disabled{opacity:.5;cursor:default}
@media(forced-colors:active){input[type=checkbox][data-centre-checklist-id],input[type=checkbox][data-centre-checklist-id]:checked{appearance:auto!important;-webkit-appearance:auto!important;accent-color:auto!important;background:revert!important;border:revert!important;color:revert!important}input[type=checkbox][data-centre-checklist-id]::after{display:none}}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--centre-accent);outline-offset:3px}
</style><script>
(()=>{
  const palettes=${JSON.stringify(palettes)}, root=document.documentElement;
  function apply(theme,colors){
    const values=colors||palettes[theme];if(!values)return;
    for(const [name,value] of Object.entries(values))if(name in palettes.dark&&typeof value==='string'&&/^#[0-9a-f]{3,8}$/i.test(value))root.style.setProperty('--centre-'+name,value);
    root.style.setProperty('color-scheme',theme==='light'?'light':'dark','important');root.dataset.theme=theme;
  }
  const media=matchMedia('(prefers-color-scheme: dark)');
  const initial=${JSON.stringify(theme ?? null)};
  apply(initial||(media.matches?'dark':'light'));
  media.addEventListener('change',()=>{if(parent===window&&!initial)apply(media.matches?'dark':'light')});
  addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='centre:theme'&&event.data.theme in palettes)apply(event.data.theme,event.data.colors)});
  if(!${JSON.stringify(aware)}){
    // Older diagrams used a light-only canvas. Remap neutral UI colours, preserving coloured geometry.
    const rgb=value=>{const m=/^rgba?\\(([^)]+)\\)/.exec(value);return m?m[1].split(/[, ]+/).map(Number):null};
    for(const element of document.querySelectorAll('body *')){
      if(!(element instanceof HTMLElement||element instanceof SVGElement)||['SCRIPT','STYLE'].includes(element.tagName))continue;
      const style=getComputedStyle(element);
      for(const property of ['background-color','color','border-top-color','border-right-color','border-bottom-color','border-left-color','fill','stroke']){
        const value=rgb(style.getPropertyValue(property));if(!value||(value.length>3&&value[3]===0))continue;
        const [r,g,b]=value,max=Math.max(r,g,b),min=Math.min(r,g,b),neutral=max-min<45;
        let token;
        if(property==='background-color'&&neutral)token=max>230?'surface':'surface-2';
        else if(property.startsWith('border-')&&neutral)token='line';
        else if(property==='color')token='text';
        else if((property==='fill'||property==='stroke')&&element.tagName.toLowerCase()==='text')token='text';
        else if(neutral&&(property==='fill'||property==='stroke'))token=max>225?'surface':'line';
        if(token)element.style.setProperty(property,'var(--centre-'+token+')','important');
      }
    }
  }
  let pending=false;
  const report=()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;parent.postMessage({type:'centre:diagram-size',height:Math.ceil(document.body.getBoundingClientRect().height)},'*')})};
  new ResizeObserver(report).observe(document.body);addEventListener('load',report);report();
})();
</script>${checklistScript}<!--/centre:bridge--></body></html>`;
}

/** Recovery renders only the supported static checklist, never generated scripts. */
function checklistRecoveryContent(html:string):string {
  const prepared = prepareChecklistContent(html);
  const elements = checkboxElements(prepared.content);
  const escape = (text:string) => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  function text(node:DefaultTreeAdapterTypes.Node):string {
    if ('tagName' in node && ['script','style','template'].includes(node.tagName)) return '';
    if ('value' in node) return node.value;
    return 'childNodes' in node ? node.childNodes.map(text).join(' ') : '';
  }
  const items = elements.map((element,index) => {
    let label:DefaultTreeAdapterTypes.Node = element;
    for (let parent = element.parentNode;parent;parent = 'parentNode' in parent ? parent.parentNode : null) {
      if ('tagName' in parent && parent.tagName === 'label') { label = parent; break; }
    }
    const inputId = element.attrs.find(attribute => attribute.name === 'id')?.value;
    if (label === element && inputId) {
      let root:DefaultTreeAdapterTypes.Node = element;
      while ('parentNode' in root && root.parentNode) root = root.parentNode;
      function find(node:DefaultTreeAdapterTypes.Node) {
        if ('tagName' in node && node.tagName === 'label' && node.attrs.some(attribute => attribute.name === 'for' && attribute.value === inputId)) label = node;
        if ('childNodes' in node) node.childNodes.forEach(find);
      }
      find(root);
    }
    const caption = text(label).replace(/\s+/g,' ').trim().slice(0,300) || `Checklist item ${index + 1}`;
    const itemId = prepared.itemIds[index];
    return `<label><input type="checkbox" data-centre-checklist-id="${itemId}"${prepared.checkedItemIds.includes(itemId) ? ' checked' : ''}> <span>${escape(caption)}</span></label>`;
  });
  return `<style>body{padding:28px}h1{font-size:20px}label{display:flex;align-items:center;gap:12px;margin:16px 0;line-height:1.5}</style><h1>Checklist</h1>${items.length ? items.join('') : '<p>This resource attempted to leave its protected frame. Reopen it to try again.</p>'}`;
}

/** The trusted parent policy blocks even self-navigation from generated HTML. */
export function diagramArtifactDocument(html:string, theme:DiagramTheme|undefined, scope:ChecklistBridgeScope):string {
  const document = diagramDocument(html,theme,scope);
  const recovery = diagramDocument(checklistRecoveryContent(html),theme,scope);
  const {itemIds} = prepareChecklistContent(html);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${diagramArtifactCsp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:${palettes[theme ?? 'dark'].bg};color-scheme:${theme === 'light' ? 'light' : 'dark'}}iframe{display:block;width:100%;height:420px;border:0}#navigation-blocked{margin:0;padding:16px 28px 0;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:${palettes[theme ?? 'dark'].text}}</style></head><body><p id="navigation-blocked" role="alert" hidden>Resource navigation was blocked. Checklist progress is still available.</p><iframe id="diagram" title="Interactive resource" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>
(()=>{
  const frame=document.getElementById('diagram'),scope=${scriptJson(scope)},allowed=new Set(${scriptJson(itemIds)}),palettes=${scriptJson(palettes)};
  const keys=value=>Object.keys(value).sort().join(',');
  let loaded=false,recovered=false,lastRestore=null,lastTheme=null,probe=null;
  const notice=document.getElementById('navigation-blocked');
  function recover(){
    if(recovered)return;recovered=true;notice.hidden=false;
    frame.srcdoc=${scriptJson(recovery)};
  }
  frame.addEventListener('load',()=>{
    if(loaded){recover();return}loaded=true;
    const nonce=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');probe=nonce;
    frame.contentWindow.postMessage({type:'centre:checklist-probe',...scope,nonce},'*');
    setTimeout(()=>{if(probe===nonce)recover()},500);
  });
  addEventListener('message',event=>{
    const data=event.data;if(!data||typeof data!=='object'||Array.isArray(data))return;
    if(event.source===frame.contentWindow){
      if(data.type==='centre:diagram-size'&&keys(data)==='height,type'&&typeof data.height==='number'&&Number.isFinite(data.height)&&data.height>=0&&data.height<=100000){frame.style.height=Math.ceil(data.height)+'px';parent.postMessage({type:data.type,height:data.height+(notice.hidden?0:notice.getBoundingClientRect().height)},'*');return}
      if(data.resourceId!==scope.resourceId||data.documentRevision!==scope.documentRevision)return;
      if(data.type==='centre:checklist-alive'&&keys(data)==='documentRevision,nonce,resourceId,type'&&data.nonce===probe){probe=null;return}
      if(data.type==='centre:checklist-ready'&&keys(data)==='documentRevision,resourceId,type'){if(lastTheme)frame.contentWindow.postMessage(lastTheme,'*');if(lastRestore)frame.contentWindow.postMessage(lastRestore,'*');parent.postMessage(data,'*');return}
      if(data.type==='centre:checklist-change'&&keys(data)==='checked,documentRevision,itemId,resourceId,type'&&allowed.has(data.itemId)&&typeof data.checked==='boolean')parent.postMessage(data,'*');
    }else if(event.source===parent){
      if(data.type==='centre:theme'&&data.theme in palettes){lastTheme=data;const color=data.colors?.bg;const bg=typeof color==='string'&&/^#[0-9a-f]{3,8}$/i.test(color)?color:palettes[data.theme].bg;document.documentElement.style.backgroundColor=bg;document.body.style.backgroundColor=bg;document.documentElement.style.colorScheme=data.theme==='light'?'light':'dark';frame.contentWindow.postMessage(data,'*');return}
      if(data.type!=='centre:checklist-restore'||keys(data)!=='checkedItemIds,documentRevision,hasProgress,resourceId,type'||data.resourceId!==scope.resourceId||data.documentRevision!==scope.documentRevision||typeof data.hasProgress!=='boolean'||!Array.isArray(data.checkedItemIds)||data.checkedItemIds.length>allowed.size)return;
      const checked=new Set();for(const id of data.checkedItemIds){if(!allowed.has(id)||checked.has(id))return;checked.add(id)}lastRestore=data;frame.contentWindow.postMessage(data,'*');
    }
  });
  frame.srcdoc=${scriptJson(document)};
})();
</script></body></html>`;
}

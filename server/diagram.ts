export type DiagramTheme = 'dark' | 'light' | 'midnight';

const palettes = {
  dark: { bg:'#1b1b1a',surface:'#20201f','surface-2':'#262625',text:'#ecebe7','text-2':'#a8a7a1',line:'#3b3b38',accent:'#8ea6e8' },
  light: { bg:'#f9f9f7',surface:'#ffffff','surface-2':'#f3f3f0',text:'#131313','text-2':'#7b7974',line:'#d8d8d5',accent:'#2a78d6' },
  midnight: { bg:'#101114',surface:'#18191e','surface-2':'#202126',text:'#e8e9ec','text-2':'#a1a3ac',line:'#36383f',accent:'#8ea6e8' },
} satisfies Record<DiagramTheme, Record<string,string>>;

export function diagramTheme(value: string | null): DiagramTheme | undefined {
  return value === 'light' || value === 'dark' || value === 'midnight' ? value : undefined;
}

export const diagramCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'";

export function diagramDocument(html: string, theme?: DiagramTheme): string {
  // Rewrap old saved documents as well as new body fragments, without accumulating bridges.
  const content = html.replace(/<!--centre:bridge-->[\s\S]*?<!--\/centre:bridge-->/g, '')
    .replace(/<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<meta\b[^>]*>/gi, '');
  const aware = /var\(\s*--(?:centre-|bg\b|surface\b|text\b|accent\b)/.test(content);
  const initial = theme ?? 'dark';
  const css = Object.entries(palettes[initial]).map(([name,value]) => `--centre-${name}:${value}`).join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${diagramCsp}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}
<!--centre:bridge--><style>
:root{${css};--bg:var(--centre-bg);--surface:var(--centre-surface);--surface-2:var(--centre-surface-2);--text:var(--centre-text);--text-2:var(--centre-text-2);--line:var(--centre-line);--accent:var(--centre-accent);color-scheme:${initial === 'light' ? 'light' : 'dark'}!important}
html,body{margin:0!important;min-height:0!important;height:auto!important;background:var(--centre-bg)!important;color:var(--centre-text)!important}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}
*,*::before,*::after{box-sizing:border-box}img,svg,canvas{max-width:100%}input,button,select,textarea{accent-color:var(--centre-accent)}
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
</script><!--/centre:bridge--></body></html>`;
}

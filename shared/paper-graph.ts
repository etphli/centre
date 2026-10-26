import type { CartesianGraph } from './paper-layout';

type Point = {x:number;y:number};
const left = 12, right = 94, top = 8, bottom = 72;
const rounded = (value:number) => Number(value.toFixed(5));
function ticks(min:number,max:number) {
  const rough = (max-min)/8;
  const magnitude = 10**Math.floor(Math.log10(rough));
  const step = [1,2,5,10].map(value => value*magnitude).find(value => value >= rough) ?? 10*magnitude;
  const values:number[] = [];
  for (let value = Math.ceil(min/step)*step;value <= max + step*0.001;value += step) values.push(rounded(value));
  return values;
}

export function graphGeometry(graph:CartesianGraph) {
  const project = (x:number,y:number):Point => ({x:rounded(left+(x-graph.xMin)/(graph.xMax-graph.xMin)*(right-left)),y:rounded(bottom-(y-graph.yMin)/(graph.yMax-graph.yMin)*(bottom-top))});
  const curves = graph.curves.map(curve => {
    const y = (x:number) => curve.a*x*x+curve.b*x+curve.c;
    const boundaries = [graph.xMin,graph.xMax];
    for (const edge of [graph.yMin,graph.yMax]) {
      if (curve.a === 0) { if (curve.b !== 0) boundaries.push((edge-curve.c)/curve.b); }
      else {
        const discriminant = curve.b*curve.b-4*curve.a*(curve.c-edge);
        if (discriminant >= 0) for (const sign of [-1,1]) boundaries.push((-curve.b+sign*Math.sqrt(discriminant))/(2*curve.a));
      }
    }
    const breaks = [...new Set(boundaries.filter(x => x >= graph.xMin && x <= graph.xMax))].sort((a,b) => a-b);
    const segments:Point[][] = [];
    for (let i=1;i<breaks.length;i++) {
      const start = breaks[i-1]!, end = breaks[i]!;
      const middle = y((start+end)/2);
      if (middle < graph.yMin || middle > graph.yMax) continue;
      const samples = Array.from({length:81},(_,index) => start+(end-start)*index/80);
      if (curve.a !== 0) {
        const vertex = -curve.b/(2*curve.a);
        if (vertex > start && vertex < end) samples.push(vertex);
      }
      segments.push(samples.sort((a,b) => a-b).map(x => project(x,y(x))));
    }
    return {label:curve.label,segments};
  });
  const origin = project(0,0);
  const projected = graph.points.map(point => ({...project(point.x,point.y),label:point.label}));
  const useKey = projected.some((point,index)=>point.label.length > 18 || projected.some((other,otherIndex)=>index !== otherIndex && Math.hypot(point.x-other.x,point.y-other.y)<7));
  const points = projected.map((point,index)=>{
    const nearbyBefore = projected.slice(0,index).filter(other=>Math.hypot(point.x-other.x,point.y-other.y)<7).length;
    const below = nearbyBefore%2 === 1 || point.y < 17;
    const alignLeft = nearbyBefore%4 >= 2 || point.x > 75;
    return {...point,label:useKey?String.fromCharCode(65+index):point.label,labelX:point.x+(alignLeft?-2:2),labelY:point.y+(below?5:-3),alignLeft};
  });
  const pointKey = useKey ? projected.map((point,index)=>`${String.fromCharCode(65+index)}: ${point.label}`) : [];
  return {left,right,top,bottom,origin,
    xTicks:ticks(graph.xMin,graph.xMax).map(value => ({value,...project(value,0)})),
    yTicks:ticks(graph.yMin,graph.yMax).map(value => ({value,...project(0,value)})),curves,
    points,pointKey,height:84+pointKey.length*4,
  };
}

const escape = (value:string) => value.replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] ?? char));
export function graphSvg(graph:CartesianGraph) {
  const g = graphGeometry(graph);
  const line = (x1:number,y1:number,x2:number,y2:number,extra='') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
  const grid = [...g.xTicks.map(t => line(t.x,g.top,t.x,g.bottom)),...g.yTicks.map(t => line(g.left,t.y,g.right,t.y))].join('');
  const labels = [...g.xTicks.filter(t=>t.value!==0).map(t=>`<text x="${t.x}" y="${g.bottom+4}" text-anchor="middle">${t.value}</text>`),...g.yTicks.filter(t=>t.value!==0).map(t=>`<text x="${g.left-2}" y="${t.y+1}" text-anchor="end">${t.value}</text>`)].join('');
  const curves = g.curves.flatMap((curve,index)=>curve.segments.map(segment=>`<polyline points="${segment.map(p=>`${p.x},${p.y}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="0.6" ${index%2?'stroke-dasharray="1.5 1"':''}/>`)).join('');
  const points = g.points.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="0.7" fill="currentColor"/><text x="${p.labelX}" y="${p.labelY}" dominant-baseline="middle" text-anchor="${p.alignLeft?'end':'start'}" stroke="var(--graph-bg,var(--surface,white))" stroke-width="1.2" paint-order="stroke">${escape(p.label)}</text>`).join('');
  const legend = g.curves.map((curve,index)=>`${index%2?'dashed: ':'solid: '}${curve.label}`).filter((_,index)=>g.curves[index]?.label).join('; ');
  const key = g.pointKey.map((label,index)=>`<text x="12" y="${86+index*4}" font-size="2.4">${escape(label)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${g.height}" role="img" aria-label="${graph.curves.length?'Plotted Cartesian graph':'Blank Cartesian graph for sketching'}" style="display:block;width:100%;font:2.7px serif;fill:currentColor"><g stroke="currentColor" stroke-width="0.15" opacity="0.22">${grid}</g><g stroke="currentColor" stroke-width="0.35">${line(g.left,g.origin.y,g.right,g.origin.y)}${line(g.origin.x,g.top,g.origin.x,g.bottom)}</g>${labels}<text x="97" y="${g.origin.y+1}">x</text><text x="${g.origin.x-1}" y="5">y</text>${curves}${points}<text x="12" y="82">${escape(legend)}</text>${key}</svg>`;
}

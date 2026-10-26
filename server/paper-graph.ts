import type { CartesianGraph } from '../shared/paper-layout';
import { graphGeometry } from '../shared/paper-graph';

export function graphLatex(graph:CartesianGraph,escape:(value:string)=>string) {
  const g = graphGeometry(graph);
  const lines = ['\\resizebox{\\linewidth}{!}{%', '\\begin{tikzpicture}[x=1mm,y=-1mm]', `\\path[use as bounding box] (0,0) rectangle (100,${g.height});`];
  for (const t of g.xTicks) {
    lines.push(`\\draw[gray!25,line width=0.15pt] (${t.x},${g.top}) -- (${t.x},${g.bottom});`);
    if (t.value !== 0) lines.push(`\\node[below,font=\\scriptsize] at (${t.x},${g.bottom}) {${t.value}};`);
  }
  for (const t of g.yTicks) {
    lines.push(`\\draw[gray!25,line width=0.15pt] (${g.left},${t.y}) -- (${g.right},${t.y});`);
    if (t.value !== 0) lines.push(`\\node[left,font=\\scriptsize] at (${g.left},${t.y}) {${t.value}};`);
  }
  lines.push(`\\draw[->] (${g.left},${g.origin.y}) -- (97,${g.origin.y}) node[right] {$x$};`,
    `\\draw[->] (${g.origin.x},${g.bottom}) -- (${g.origin.x},5) node[above] {$y$};`);
  for (const [index,curve] of g.curves.entries()) for (const segment of curve.segments)
    lines.push(`\\draw[line width=0.7pt,${index%2?'dashed':'solid'}] plot coordinates {${segment.map(p=>`(${p.x},${p.y})`).join(' ')}};`);
  for (const p of g.points) {
    lines.push(`\\fill (${p.x},${p.y}) circle (0.65mm);`);
    lines.push(`\\node[anchor=${p.alignLeft?'east':'west'},font=\\scriptsize,fill=white,inner sep=1pt] at (${p.labelX},${p.labelY}) {${escape(p.label)}};`);
  }
  const legend = g.curves.map((curve,index)=>curve.label ? `${index%2?'Dashed':'Solid'}: ${escape(curve.label)}` : '').filter(Boolean).join('\\quad ');
  if (legend) lines.push(`\\node[anchor=west,font=\\scriptsize] at (12,82) {${legend}};`);
  g.pointKey.forEach((label,index)=>lines.push(`\\node[anchor=west,font=\\scriptsize] at (12,${86+index*4}) {${escape(label)}};`));
  return [...lines,'\\end{tikzpicture}%','}'].join('\n');
}

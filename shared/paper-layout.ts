import { z } from 'zod';

const coordinate = z.number().min(-10000).max(10000);
export const cartesianGraphSchema = z.object({
  xMin:coordinate, xMax:coordinate, yMin:coordinate, yMax:coordinate,
  curves:z.array(z.object({a:coordinate,b:coordinate,c:coordinate,label:z.string().max(40)}).strict()).max(4),
  points:z.array(z.object({x:coordinate,y:coordinate,label:z.string().max(60)}).strict()).max(12),
}).strict().superRefine((graph,ctx) => {
  if (!(graph.xMin < 0 && graph.xMax > 0 && graph.yMin < 0 && graph.yMax > 0))
    ctx.addIssue({code:'custom',message:'Graph bounds must contain the origin strictly inside both axes.'});
  if (graph.xMax - graph.xMin < 0.01 || graph.yMax - graph.yMin < 0.01)
    ctx.addIssue({code:'custom',message:'Graph axes must span at least 0.01 units.'});
  graph.points.forEach((point,index) => {
    if (point.x < graph.xMin || point.x > graph.xMax || point.y < graph.yMin || point.y > graph.yMax)
      ctx.addIssue({code:'custom',path:['points',index],message:'A labelled point must be inside the graph bounds.'});
  });
});
export type CartesianGraph = z.infer<typeof cartesianGraphSchema>;

export const workingSpaceSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('none')}).strict(),
  z.object({kind:z.literal('lines'),lines:z.number().int().min(1).max(16)}).strict(),
  z.object({kind:z.literal('blank'),heightMm:z.number().int().min(10).max(120)}).strict(),
]);
export const paperLayoutSchema = z.object({
  workingSpace:workingSpaceSchema,
  graphPlacement:z.enum(['below','beside']),
  questionGraph:cartesianGraphSchema.nullable(),
  answerGraph:cartesianGraphSchema.nullable(),
  startOnNewPage:z.boolean(),
}).strict().superRefine((layout,ctx) => {
  if (layout.questionGraph && layout.graphPlacement === 'below' &&
      ((layout.workingSpace.kind === 'lines' && layout.workingSpace.lines > 8) ||
       (layout.workingSpace.kind === 'blank' && layout.workingSpace.heightMm > 64))) {
    ctx.addIssue({code:'custom',message:'A graph below the working needs at most 8 working lines or 64mm blank space to fit on a page. Choose beside for more working space.'});
  }
});
export type PaperLayout = z.infer<typeof paperLayoutSchema>;

export function questionPaperLayout(question:{responseType:string;marks:number;paperLayout?:PaperLayout|null}):PaperLayout {
  return question.paperLayout ?? {
    workingSpace:question.responseType === 'multiple_choice' ? {kind:'none'}
      : {kind:'lines',lines:Math.min(12,Math.max(3,question.marks + (question.responseType === 'long_response' ? 2 : 0)))},
    graphPlacement:'below',questionGraph:null,answerGraph:null,startOnNewPage:false,
  };
}

export const paperLayoutInstructions = `For every test question choose paperLayout to suit the actual task and supplied reference images. Set workingSpace to {kind:"none"}, {kind:"lines",lines:1..16}, or {kind:"blank",heightMm:10..120}. Choose graphPlacement "beside" for working alongside a graph or "below" for a larger graph. A graph below the working allows at most 8 lines or 64mm blank space so both fit on one page; choose beside when more working is needed. Set startOnNewPage when a substantial question needs its own page. Use real LaTeX enumerate environments for distinct lettered subparts with their own marks, rather than one run-on paragraph. Assign marks to the work actually required; do not pad every question to the same mark value or force a total of 100.
For Cartesian graph tasks supply questionGraph and answerGraph as numeric data with xMin,xMax,yMin,yMax,curves,points. Both axes must include zero strictly inside their ranges. Each curve is y=a*x^2+b*x+c with numeric a,b,c and a short plain-text label; a=0 also supports straight lines. Each point has numeric x,y and a short plain-text label. Include all labelled points within the chosen bounds. Use empty curves and points for blank sketching axes in questionGraph. Never put a solution curve or answer coordinates on those blank axes. For a supplied graph that the student must interpret, include its curves and given points in questionGraph. In answerGraph, include the correct plotted curves and key labelled points so graphing can be self-marked visually. Use null for graphs that are unnecessary. Graphs render from this data; do not write TikZ, SVG, packages or drawing commands in text fragments. Choose ranges that separate nearby intercepts and show vertices clearly. Match the methods and level of the supplied examples, increasing difficulty through varied reasoning and graph features rather than repetitive arithmetic. Check all roots, vertices, coefficients, labels and mark totals before returning. Use null paperLayout for non-test resources.`;

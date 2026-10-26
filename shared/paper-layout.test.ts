import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianGraphSchema, paperLayoutSchema, questionPaperLayout } from './paper-layout';
import { graphGeometry, graphSvg } from './paper-graph';
import { resourceSchema } from './schema';
import { paperFragmentMarkdown } from './test-paper';

const graph = {xMin:-3,xMax:7,yMin:-12,yMax:10,curves:[{a:1,b:-2,c:-8,label:'f'}],points:[{x:1,y:-9,label:'V'}]};
test('portable graph data survives a saved resource round trip',()=>{
  const paperLayout = {workingSpace:{kind:'lines',lines:6},graphPlacement:'beside',questionGraph:{...graph,curves:[],points:[]},answerGraph:graph,startOnNewPage:false};
  const resource = resourceSchema.parse({id:'paper',subjectId:null,topicId:null,title:'Parabolas',kind:'test',createdAt:'now',updatedAt:'now',content:'',questions:[{id:'q',prompt:'Sketch.',answer:'',paperLayout}]});
  assert.deepEqual(resourceSchema.parse(JSON.parse(JSON.stringify(resource))).questions[0]?.paperLayout,paperLayout);
  assert.deepEqual(questionPaperLayout({responseType:'multiple_choice',marks:1}).workingSpace,{kind:'none'});
  assert.equal(questionPaperLayout({responseType:'long_response',marks:8}).workingSpace.kind,'lines');
});
test('graph bounds, points, coefficients and workspaces reject unsafe or unusable data',()=>{
  for(const bad of [{...graph,xMin:2},{...graph,yMax:0},{...graph,xMax:Infinity},{...graph,curves:[{a:NaN,b:0,c:0,label:''}]},{...graph,points:[{x:50,y:0,label:'bad'}]}])assert.equal(cartesianGraphSchema.safeParse(bad).success,false);
  assert.equal(paperLayoutSchema.safeParse({workingSpace:{kind:'blank',heightMm:500},graphPlacement:'below',questionGraph:null,answerGraph:null,startOnNewPage:false}).success,false);
  assert.equal(paperLayoutSchema.safeParse({workingSpace:{kind:'lines',lines:16},graphPlacement:'below',questionGraph:graph,answerGraph:null,startOnNewPage:false}).success,false);
});
test('curves are clipped mathematically and include the exact vertex',()=>{
  const g=graphGeometry(graph);
  const vertex=g.points[0]!;
  assert.ok(g.curves[0]?.segments.flat().some(p=>p.x===vertex.x&&p.y===vertex.y));
  for(const p of g.curves.flatMap(c=>c.segments.flat()))assert.ok(p.x>=g.left&&p.x<=g.right&&p.y>=g.top-0.00001&&p.y<=g.bottom+0.00001);
  assert.equal(graphGeometry({...graph,curves:[{a:0,b:0,c:100,label:''}]}).curves[0]?.segments.length,0);
  assert.ok(graphGeometry({...graph,curves:[{a:0,b:2,c:1,label:''}]}).curves[0]?.segments.length);
});
test('SVG labels escape markup and blank axes contain no solution',()=>{
  const svg=graphSvg({...graph,curves:[],points:[]});
  assert.ok(!svg.includes('<polyline'));
  assert.match(svg,/Blank Cartesian graph/);
  const malicious=graphSvg({...graph,points:[{x:0,y:0,label:'<script>alert(1)</script>'}]});
  assert.ok(!malicious.includes('<script>'));
  assert.match(malicious,/&lt;script&gt;/);
});
test('nearby intercepts and long labels use a readable point key',()=>{
  const g=graphGeometry({...graph,points:[{x:0,y:0,label:'exact intercept near zero'},{x:0.1,y:0,label:'second intercept'}]});
  assert.deepEqual(g.points.map(point=>point.label),['A','B']);
  assert.deepEqual(g.pointKey,['A: exact intercept near zero','B: second intercept']);
});
test('paper subparts and paragraph breaks read as prose in previews',()=>{
  assert.equal(paperFragmentMarkdown('First.\\par Next.'),'First.\n\n Next.');
  assert.match(paperFragmentMarkdown('\\begin{enumerate}[label=(\\alph*)]\\item Factorise.\\item Sketch.\\end{enumerate}'),/1\. Factorise\.\n\n2\. Sketch\./);
});

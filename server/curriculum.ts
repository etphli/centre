import { HttpError,errorMessage } from './errors';
import { z } from 'zod';

const officialHosts = new Set(['curriculum.nsw.edu.au','www.nsw.gov.au','education.nsw.gov.au','educationstandards.nsw.edu.au','www.educationstandards.nsw.edu.au']);
const maximumBytes = 2 * 1024 * 1024;
type Outcome = {code:string;description:string;stages:string[]};
type Evidence = { url:string;title:string;text:string;fetchedAt:string;outcomes:Outcome[] };
const cache = new Map<string,{ expires:number;work:Promise<Evidence> }>();
function officialUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.port) throw new HttpError(400,'Curriculum sources must use an official NSW education HTTPS URL.');
  url.hash = ''; return url;
}
function plainText(html: string) {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_match,value: string) => { const code = value.startsWith('x') ? Number.parseInt(value.slice(1),16) : Number(value); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g,entity => ({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[entity] ?? ' ')).replace(/\s+/g,' ').trim();
}
function embeddedOutcomes(html: string): Outcome[] {
  const script = /<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!script) return [];
  let data: unknown; try { data = JSON.parse(script); } catch { return []; }
  const page = z.object({props:z.object({pageProps:z.object({data:z.object({syllabus:z.object({linkedItems:z.record(z.string(),z.unknown())})})})})}).safeParse(data);
  if (!page.success) return [];
  const outcomeSchema = z.object({system:z.object({type:z.literal('outcome')}),elements:z.object({code:z.object({value:z.string()}),description:z.object({value:z.string()}),stages__stages:z.object({value:z.array(z.object({name:z.string()}))})})});
  return Object.values(page.data.props.pageProps.data.syllabus.linkedItems).flatMap(value => {
    const parsed = outcomeSchema.safeParse(value); if (!parsed.success) return [];
    return [{code:parsed.data.elements.code.value,description:plainText(parsed.data.elements.description.value),stages:parsed.data.elements.stages__stages.value.map(stage => stage.name)}];
  });
}
export async function readCurriculum(value: string): Promise<Evidence> {
  const initial = officialUrl(value); const key = initial.href;
  const saved = cache.get(key); if (saved && saved.expires > Date.now()) return saved.work;
  const work = (async () => {
    let url = initial;
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{Accept:'text/html, text/plain'}});
      if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) throw new Error('Official curriculum redirect has no destination.'); url = officialUrl(new URL(location,url).href); continue; }
      if (!response.ok) throw new Error(`Official curriculum lookup failed (${response.status}).`);
      if (!/text\/(?:html|plain)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('The curriculum source is not a readable HTML or text page.'); }
      if (Number(response.headers.get('content-length') ?? 0) > maximumBytes) { await response.body?.cancel(); throw new Error('The curriculum page exceeds the size limit.'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('The curriculum page is empty.');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > maximumBytes) throw new Error('The curriculum page exceeds the size limit.'); chunks.push(result.value); } } finally { await reader.cancel().catch(() => undefined); }
      const html = Buffer.concat(chunks).toString('utf8');
      const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? url.pathname);
      const body = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
      const text = plainText(body); if (text.length < 80) throw new Error('The official page did not provide enough readable curriculum text.');
      return {url:url.href,title,text:text.slice(0,80000),fetchedAt:new Date().toISOString(),outcomes:embeddedOutcomes(html)};
    }
    throw new Error('The official curriculum page redirected too many times.');
  })();
  cache.set(key,{expires:Date.now()+15*60000,work});
  try { return await work; } catch (error) { cache.delete(key); throw error; }
}
export function studentContext(subjectName: string, yearLevel = 9) {
  const explicit = /\b(?:year|yr)\s*(7|8|9|10|11|12)(?!\d)/i.exec(subjectName);
  const subjectYearLevel = explicit ? Number(explicit[1]) : yearLevel;
  return {jurisdiction:'New South Wales, Australia',authority:'NSW Education Standards Authority (NESA)',profileYearLevel:yearLevel,yearLevel:subjectYearLevel,stage:subjectYearLevel <= 8 ? 4 : subjectYearLevel <= 10 ? 5 : 6,yearSource:explicit ? 'subject name' : 'student profile',subjectName};
}
export async function getCurriculumContext(subjectName: string, yearLevel = 9) {
  const student = studentContext(subjectName,yearLevel);
  const sources = /math/i.test(subjectName) && student.yearLevel <= 10 ? ['https://curriculum.nsw.edu.au/learning-areas/mathematics/mathematics-k-10-2022/outcomes'] : /english/i.test(subjectName) && student.yearLevel <= 10 ? ['https://curriculum.nsw.edu.au/learning-areas/english/english-k-10-2022/outcomes'] : /science/i.test(subjectName) && student.yearLevel <= 10 ? ['https://curriculum.nsw.edu.au/learning-areas/science/science-7-10-2023/outcomes'] : [];
  const evidence: Evidence[] = []; const errors: string[] = [];
  for (const url of sources) {
    try {
      const source = await readCurriculum(url);
      const outcomes = source.outcomes.filter(outcome => (outcome.stages.includes(`Stage ${student.stage}`) || outcome.code.startsWith('MAO-')) && (!/^(?:MALS|ENLS|SCLS)/.test(outcome.code) || /life\s*skills/i.test(subjectName)));
      const prefix = student.stage === 5 ? /(?:MA5[.-]|EN5-|SC5-)/ : student.stage === 4 ? /(?:MA4[.-]|EN4-|SC4-)/ : /Stage 6/;
      const start = source.text.search(prefix);
      const excerpt = start >= 0 ? source.text.slice(Math.max(0,start-250),start+16000) : source.text.slice(0,16000);
      evidence.push({...source,outcomes,text:outcomes.length ? `Official Stage ${student.stage} outcomes retrieved from this page:\n${outcomes.map(outcome => `${outcome.code}: ${outcome.description}`).join('\n')}\n\nPage excerpt: ${excerpt}` : excerpt});
    } catch (error) { errors.push(errorMessage(error)); }
  }
  return {student,verified:evidence.length > 0,evidence,errors,officialIndex:'https://curriculum.nsw.edu.au/',guidance:'Only assert specific NESA outcomes, dates or alignment supported by fetched official evidence. Cite the source URL. When no evidence was retrieved, use official web lookup or say alignment is unverified. Subject year overrides the profile year. School sequencing and Core/Path choices must come from the student or teacher.'};
}

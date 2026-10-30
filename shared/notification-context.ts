import type { Snapshot } from './schema';

// Include source text rather than asking the model to infer a notice from its title.
export function assignmentNotificationContext(state:Pick<Snapshot,'resources'|'assignments'|'subjects'>, text:string, subjectId?:string, resourceId?:string) {
  const normalized = text.toLocaleLowerCase();
  const mentionedSubjects = new Set(state.subjects.filter(subject => [subject.name,subject.shortName].some(name => name && normalized.includes(name.toLocaleLowerCase()))).map(subject => subject.id));
  const words = (value:string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const generic = new Set(['assignment','assessment','task','exam','test','notification','year','work','the','and','for','with','help','my']);
  const mentioned = new Set(words(text));
  const titleTokens = state.assignments.map(item => ({id:item.id,tokens:new Set(words(item.title).filter(token => token.length > 3 && !generic.has(token)))}));
  const uniqueMention = (id:string) => [...(titleTokens.find(item => item.id === id)?.tokens ?? [])].some(token => mentioned.has(token) && titleTokens.filter(item => item.tokens.has(token)).length === 1);
  const linkedItems = new Set(state.assignments.filter(item => uniqueMention(item.id) || normalized.includes(item.id.toLocaleLowerCase()) || normalized.includes(item.title.toLocaleLowerCase())).map(item => item.id));
  const resources = state.resources.filter(resource => !resource.deletedAt && resource.notification);
  const selected = resources.filter(resource => resource.id === resourceId || linkedItems.has(resource.notification?.itemId ?? '') || resource.subjectId === subjectId || (resource.subjectId && mentionedSubjects.has(resource.subjectId)) || normalized.includes(resource.title.toLocaleLowerCase()));
  const relevant = selected.length || !/\bnotifications?\b/i.test(text) ? selected : resources;
  return relevant.map(({id,title,content,notification}) => ({id,title,notification,untrustedContent:content}));
}

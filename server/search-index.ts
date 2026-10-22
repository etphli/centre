import { extname } from 'node:path';
import { connectorCatalog } from '../shared/connectors';
import type { SearchResult, SearchTarget } from '../shared/search';
import { MAX_SEARCH_RESULTS, MAX_SEARCH_SNIPPET_LENGTH } from '../shared/search';
import type { Chat, Resource, Snapshot } from '../shared/schema';
import type { AttachmentStore } from './attachments';

const MAX_QUERY_TERMS = 16;
const MAX_CANDIDATES = 160;
const MAX_PREFIX_TERMS = 64;
const SNIPPET_CONTEXT = 96;
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

type TokenOccurrence = { term: string; start: number; end: number; index: number };
type IndexedDocument = Omit<SearchResult, 'snippet' | 'highlights'> & { text: string; bodyStart?: number; bodyEnd?: number; positions: Map<string, TokenOccurrence[]>; tokenTerms: string[]; order: number };
type AttachmentSearchText = Awaited<ReturnType<AttachmentStore['searchText']>>;

function normalizeTerm(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '');
}

function tokenize(value: string): TokenOccurrence[] {
  let index = 0;
  return [...value.matchAll(TOKEN_PATTERN)].flatMap(match => {
    const raw = match[0];
    const start = match.index;
    const term = normalizeTerm(raw);
    if (start === undefined || !term) return [];
    const token = { term, start, end: start + raw.length, index };
    index += 1;
    return [token];
  });
}

function locationLabel(snapshot: Snapshot, resource: Resource): string | undefined {
  const subject = snapshot.subjects.find(value => value.id === resource.subjectId)?.name;
  const topic = snapshot.topics.find(value => value.id === resource.topicId)?.name;
  const label = [subject, topic].filter((value): value is string => Boolean(value)).join(' / ');
  return label || undefined;
}

function connectedContent(resource: Resource): string {
  const file = resource.connectedFile;
  if (!file) return resource.content;
  const sheets = file.sheets.map(sheet => `${sheet.title}\n${sheet.rows.map(row => row.join('\t')).join('\n')}`).join('\n\n');
  const slides = file.slides.map((slide, index) => `Slide ${index + 1}\n${slide.text}`).join('\n\n');
  return [resource.content, sheets, slides].filter(Boolean).join('\n\n');
}

function attachmentSourceLabel(name: string): string {
  const extension = extname(name).toLowerCase();
  if (extension === '.pdf') return 'PDF attachment';
  if (extension === '.docx') return 'DOCX attachment';
  return 'Text attachment';
}

function connectedSourceLabel(resource: Resource): string {
  const file = resource.connectedFile;
  const connectorName = file ? connectorCatalog.find(connector => connector.id === file.connector)?.name : undefined;
  return connectorName ? `Saved ${connectorName}` : 'Saved connected file';
}

function messageTarget(chat: Chat, messageId?: string): SearchTarget {
  return { kind: 'chat', chatId: chat.id, ...(messageId ? { messageId } : {}) };
}

export function makeSearchSnippet(text: string, positions: ReadonlyMap<string, TokenOccurrence[]>, queryTerms: ReadonlySet<string>, bodyStart = 0, bodyEnd = text.length): Pick<SearchResult, 'snippet' | 'highlights'> {
  let first: TokenOccurrence | undefined;
  for (const term of queryTerms) {
    const occurrence = positions.get(term)?.[0];
    if (occurrence && (!first || occurrence.start < first.start)) first = occurrence;
  }
  if (!first) return { snippet: '', highlights: [] };
  const inBody = first.start >= bodyStart && first.start < bodyEnd;
  const beginning = inBody ? bodyStart : 0;
  const limit = inBody ? bodyEnd : text.length;
  let start = Math.max(beginning, first.start - SNIPPET_CONTEXT);
  let end = Math.min(limit, start + MAX_SEARCH_SNIPPET_LENGTH - 4);
  if (start > beginning && !/\s/u.test(text[start - 1] ?? '')) {
    const nextSpace = text.indexOf(' ', start);
    const nextLine = text.indexOf('\n', start);
    const boundary = [nextSpace, nextLine].filter(position => position >= 0).sort((a, b) => a - b)[0];
    if (boundary !== undefined && boundary < first.start && boundary - start < 24) start = boundary + 1;
  }
  if (end < limit) {
    const previousSpace = text.lastIndexOf(' ', end);
    const previousLine = text.lastIndexOf('\n', end);
    const boundary = Math.max(previousSpace, previousLine);
    if (boundary > first.start) end = boundary;
  }

  const raw = text.slice(start, end);
  const leftTrim = raw.length - raw.trimStart().length;
  const visibleText = raw.trim();
  const prefix = start > beginning ? '… ' : '';
  const suffix = end < limit ? ' …' : '';
  const snippet = `${prefix}${visibleText}${suffix}`.slice(0, MAX_SEARCH_SNIPPET_LENGTH);
  const visibleStart = start + leftTrim;
  const snippetStart = prefix.length;
  const snippetEnd = Math.min(snippet.length, snippetStart + visibleText.length);
  const visibleLimit = visibleStart + Math.max(0, snippetEnd - snippetStart);
  const highlights: [number, number][] = [];
  for (const term of queryTerms) {
    const occurrences = positions.get(term) ?? [];
    let low = 0;
    let high = occurrences.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((occurrences[middle]?.start ?? 0) < visibleStart) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < occurrences.length && highlights.length < 24; index++) {
      const occurrence = occurrences[index];
      if (!occurrence || occurrence.start >= visibleLimit) break;
      highlights.push([snippetStart + occurrence.start - visibleStart, snippetStart + Math.min(occurrence.end, visibleLimit) - visibleStart]);
    }
  }
  highlights.sort((left, right) => left[0] - right[0]);
  highlights.length = Math.min(highlights.length, 24);
  return { snippet, highlights };
}

function phraseMatches(document: IndexedDocument, queryTerms: readonly string[]): boolean {
  if (queryTerms.length < 2) return false;
  const anchorOffset = queryTerms.reduce((bestOffset, term, offset) => {
    return (document.positions.get(term)?.length ?? Infinity) < (document.positions.get(queryTerms[bestOffset] ?? '')?.length ?? Infinity) ? offset : bestOffset;
  }, 0);
  const anchorTerm = queryTerms[anchorOffset];
  if (!anchorTerm) return false;
  for (const occurrence of document.positions.get(anchorTerm) ?? []) {
    const start = occurrence.index - anchorOffset;
    if (start < 0) continue;
    if (queryTerms.every((term, offset) => document.tokenTerms[start + offset] === term)) return true;
  }
  return false;
}

function groupKind(resource: Resource): string {
  if (resource.connectedFile) return 'Connected file';
  switch (resource.kind) {
    case 'quiz': return 'Quiz';
    case 'test': return 'Test';
    case 'flashcards': return 'Flashcards';
    case 'diagram': return 'Diagram';
    case 'notes': return 'Notes';
  }
}

function questionDocuments(resource: Resource, snapshot: Snapshot, add: (document: Omit<IndexedDocument, 'positions' | 'tokenTerms' | 'order'>) => void): void {
  const resourceLabel = resource.title;
  const contextLabel = locationLabel(snapshot, resource);
  const frontLabel = resource.kind === 'flashcards' ? 'Flashcard front' : `${groupKind(resource)} prompt`;
  const backLabel = resource.kind === 'flashcards' ? 'Flashcard back' : `${groupKind(resource)} answer`;
  for (const question of resource.questions) {
    const target: SearchTarget = { kind: 'resource', resourceId: resource.id, questionId: question.id };
    const choices = question.choices.join('\n');
    add({ id: `question:${resource.id}:${question.id}:prompt`, kind: 'question', label: resourceLabel, sourceLabel: frontLabel, contextLabel, text: [question.prompt, choices].filter(Boolean).join('\n'), target });
    add({ id: `question:${resource.id}:${question.id}:answer`, kind: 'question', label: resourceLabel, sourceLabel: backLabel, contextLabel, text: question.answer, target });
    if (question.explanation.trim()) add({ id: `question:${resource.id}:${question.id}:explanation`, kind: 'question', label: resourceLabel, sourceLabel: `${groupKind(resource)} explanation`, contextLabel, text: question.explanation, target });
  }
}

function chatDocuments(chat: Chat, add: (document: Omit<IndexedDocument, 'positions' | 'tokenTerms' | 'order'>) => void): void {
  add({ id: `chat:${chat.id}`, kind: 'chat', label: chat.title || 'New chat', sourceLabel: 'Chat title', text: chat.title, target: messageTarget(chat) });
  for (const message of chat.messages) {
    if (message.content.trim()) {
      add({ id: `message:${chat.id}:${message.id}`, kind: 'message', label: chat.title || 'New chat', sourceLabel: message.role === 'user' ? 'Your message' : 'Centre reply', text: message.content, target: messageTarget(chat, message.id) });
    }
  }
}

function addDocument(
  documents: Map<string, IndexedDocument>,
  postings: Map<string, Set<string>>,
  order: number,
  document: Omit<IndexedDocument, 'positions' | 'tokenTerms' | 'order'>,
): number {
  if (!document.text.trim()) return order;
  const tokens = tokenize(document.text);
  if (!tokens.length) return order;
  const positions = new Map<string, TokenOccurrence[]>();
  for (const token of tokens) {
    const termPositions = positions.get(token.term);
    if (termPositions) termPositions.push(token);
    else positions.set(token.term, [token]);
  }
  const indexed: IndexedDocument = { ...document, label: document.label.trim().slice(0, 300) || document.sourceLabel, contextLabel: document.contextLabel?.slice(0, 300), positions, tokenTerms: tokens.map(token => token.term), order };
  documents.set(indexed.id, indexed);
  for (const term of new Set(tokens.map(token => token.term))) {
    const existing = postings.get(term);
    if (existing) existing.add(indexed.id);
    else postings.set(term, new Set([indexed.id]));
  }
  return order + 1;
}

export class SearchIndex {
  private documents = new Map<string, IndexedDocument>();
  private postings = new Map<string, Set<string>>();
  private vocabulary: string[] = [];
  private attachmentCache = new Map<string, Promise<AttachmentSearchText>>();
  private resourceRecords = new Map<string, Resource>();
  private chatRecords = new Map<string, Chat>();
  private activeAttachmentDocumentIds = new Set<string>();
  private rebuildVersion = 0;

  constructor(private readonly attachments: Pick<AttachmentStore, 'searchText'>) {}

  async rebuild(snapshot: Snapshot): Promise<void> {
    const version = ++this.rebuildVersion;
    this.resourceRecords = new Map(snapshot.resources.map(resource => [resource.id, resource]));
    this.chatRecords = new Map(snapshot.chats.map(chat => [chat.id, chat]));
    const documents = new Map<string, IndexedDocument>();
    const postings = new Map<string, Set<string>>();
    let order = 0;
    const add = (document: Omit<IndexedDocument, 'positions' | 'tokenTerms' | 'order'>) => { order = addDocument(documents, postings, order, document); };

    for (const subject of snapshot.subjects) add({ id: `subject:${subject.id}`, kind: 'subject', label: subject.name, sourceLabel: 'Subject', text: [subject.name, subject.shortName].filter(Boolean).join('\n'), target: { kind: 'subject', subjectId: subject.id } });
    for (const topic of snapshot.topics) {
      const subject = snapshot.subjects.find(value => value.id === topic.subjectId);
      add({ id: `topic:${topic.id}`, kind: 'topic', label: topic.name, sourceLabel: 'Topic', contextLabel: subject?.name, text: [topic.name, topic.description].filter(Boolean).join('\n'), target: { kind: 'topic', subjectId: topic.subjectId, topicId: topic.id } });
    }
    for (const resource of snapshot.resources) {
      if (resource.deletedAt) continue;
      const contextLabel = locationLabel(snapshot, resource);
      const content = connectedContent(resource);
      const bodyStart = resource.title.length + 1;
      add({ id: `resource:${resource.id}`, kind: 'resource', label: resource.title, sourceLabel: resource.connectedFile ? connectedSourceLabel(resource) : `${groupKind(resource)} content`, contextLabel, text: [resource.title, content, resource.kind].join('\n'), bodyStart, bodyEnd: bodyStart + content.length, target: { kind: 'resource', resourceId: resource.id } });
      questionDocuments(resource, snapshot, add);
    }
    const attachmentOwners = new Map<string, { chat: Chat; messageId: string }[]>();
    for (const chat of snapshot.chats) {
      if (!chat.deletedAt) chatDocuments(chat, add);
      for (const message of chat.messages) {
        for (const id of new Set(message.attachmentIds)) {
          const existing = attachmentOwners.get(id);
          if (!existing) attachmentOwners.set(id, [{ chat, messageId: message.id }]);
          else if (!existing.some(owner => owner.chat.id === chat.id)) existing.push({ chat, messageId: message.id });
        }
      }
    }
    for (const event of snapshot.events) add({ id: `event:${event.id}`, kind: 'event', label: event.title, sourceLabel: 'Calendar event', contextLabel: event.date, text: [event.title, event.notes].filter(Boolean).join('\n'), target: { kind: 'calendar' } });
    for (const assignment of snapshot.assignments) add({ id: `assignment:${assignment.id}`, kind: 'assignment', label: assignment.title, sourceLabel: 'Assignment', contextLabel: assignment.dueDate ? `Due ${assignment.dueDate}` : assignment.status, text: assignment.title, target: { kind: 'calendar' } });

    const owners = [...attachmentOwners.entries()].flatMap(([id, candidates]) => candidates.length === 1 ? candidates.filter(owner => !owner.chat.deletedAt).map(owner => [id, owner] as const) : []);
    this.activeAttachmentDocumentIds = new Set(owners.map(([id, owner]) => `attachment:${owner.chat.id}:${owner.messageId}:${id}`));
    for (let offset = 0; offset < owners.length; offset += 16) {
      const batch = owners.slice(offset, offset + 16);
      const values = await Promise.all(batch.map(async ([id, owner]) => ({ id, owner, value: await this.attachmentText(id) })));
      for (const { id, owner, value } of values) {
        if (!value?.text?.trim()) continue;
        const name = value.attachment.name;
        add({ id: `attachment:${owner.chat.id}:${owner.messageId}:${id}`, kind: 'attachment', label: name, sourceLabel: attachmentSourceLabel(name), contextLabel: owner.chat.title || 'Chat', text: [name, value.text].join('\n'), bodyStart: name.length + 1, target: messageTarget(owner.chat, owner.messageId) });
      }
    }

    if (version === this.rebuildVersion) {
      const activeAttachmentIds = new Set(owners.map(([id]) => id));
      for (const id of this.attachmentCache.keys()) if (!activeAttachmentIds.has(id)) this.attachmentCache.delete(id);
      this.documents = documents;
      this.postings = postings;
      this.vocabulary = [...postings.keys()].sort();
    }
  }

  search(query: string): SearchResult[] {
    const sequence = tokenize(query).map(token => token.term).slice(0, MAX_QUERY_TERMS);
    const terms = [...new Set(sequence)];
    if (!terms.length) return [];
    const lastTerm = sequence.at(-1);
    const alternatives = terms.map(term => term === lastTerm && term.length >= 2 ? this.prefixTerms(term) : [term]);
    const groups = alternatives.map(group => group.flatMap(term => { const list = this.postings.get(term); return list ? [list] : []; }));
    if (groups.some(group => !group.length)) return [];
    groups.sort((left, right) => left.reduce((sum, list) => sum + list.size, 0) - right.reduce((sum, list) => sum + list.size, 0));
    const rarest = groups[0];
    if (!rarest) return [];

    const candidates: IndexedDocument[] = [];
    const seen = new Set<string>();
    candidateLoop: for (const list of rarest) {
      for (const id of list) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!groups.every(group => group.some(postings => postings.has(id)))) continue;
        const document = this.documents.get(id);
        if (document && this.isVisible(document)) candidates.push(document);
        if (candidates.length >= MAX_CANDIDATES) break candidateLoop;
      }
    }
    candidates.sort((left, right) => {
      const leftPhrase = phraseMatches(left, sequence) ? 1 : 0;
      const rightPhrase = phraseMatches(right, sequence) ? 1 : 0;
      if (leftPhrase !== rightPhrase) return rightPhrase - leftPhrase;
      const leftCount = terms.reduce((count, term) => count + Math.min(left.positions.get(term)?.length ?? 0, 20), 0);
      const rightCount = terms.reduce((count, term) => count + Math.min(right.positions.get(term)?.length ?? 0, 20), 0);
      if (leftCount !== rightCount) return rightCount - leftCount;
      return left.order - right.order;
    });

    const queryTerms = new Set(alternatives.flat());
    return candidates.slice(0, MAX_SEARCH_RESULTS).map(document => ({
      id: document.id,
      kind: document.kind,
      label: document.label,
      sourceLabel: document.sourceLabel,
      ...(document.contextLabel ? { contextLabel: document.contextLabel } : {}),
      ...makeSearchSnippet(document.text, document.positions, queryTerms, document.bodyStart, document.bodyEnd),
      target: document.target,
    }));
  }

  private isVisible(document: IndexedDocument): boolean {
    if (document.target.kind === 'resource') {
      const resource = this.resourceRecords.get(document.target.resourceId);
      return Boolean(resource && !resource.deletedAt);
    }
    if (document.target.kind === 'chat') {
      const chat = this.chatRecords.get(document.target.chatId);
      return Boolean(chat && !chat.deletedAt && (document.kind !== 'attachment' || this.activeAttachmentDocumentIds.has(document.id)));
    }
    return true;
  }

  private prefixTerms(prefix: string): string[] {
    let low = 0;
    let high = this.vocabulary.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.vocabulary[middle] ?? '') < prefix) low = middle + 1;
      else high = middle;
    }
    const terms: string[] = [];
    for (let index = low; index < this.vocabulary.length && terms.length < MAX_PREFIX_TERMS; index++) {
      const term = this.vocabulary[index];
      if (!term?.startsWith(prefix)) break;
      terms.push(term);
    }
    return terms;
  }

  private attachmentText(id: string): Promise<AttachmentSearchText> {
    const cached = this.attachmentCache.get(id);
    if (cached) return cached;
    const loaded = this.attachments.searchText(id).catch(() => { this.attachmentCache.delete(id); return undefined; });
    this.attachmentCache.set(id, loaded);
    return loaded;
  }
}

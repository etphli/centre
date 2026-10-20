import { ConnectedFileView } from './ConnectedFileView';
import { connectorCatalog } from '../../shared/connectors';
import { ArrowUpRight, Check, Eye } from 'lucide-react';
import type { Resource } from '../../shared/schema';
import { DeleteResource } from './DeleteResource';
import { Dialog } from './Dialog';
import { useApp } from './context';
import { plural, timeAgo } from './format';
import { kindIcons, kindLabels } from './icons';
import { Markdown } from './Markdown';
import { PaperPreview } from './PaperPreview';
import { DiagramFrame,OpenDiagramButton } from './DiagramFrame';

type Card = { front: string; back: string };

/** Reads flashcards from structured questions, or from the JSON the generator returned. */
function readCards(resource: Resource): Card[] {
  if (resource.questions.length) return resource.questions.map((q) => ({ front: q.prompt, back: q.answer }));
  try {
    const raw: unknown = JSON.parse(resource.content);
    const list = raw && typeof raw === 'object' && 'cards' in raw ? (raw as { cards: unknown }).cards : raw;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item: Record<string, unknown>) => {
      const front = item?.front ?? item?.prompt ?? item?.question;
      const back = item?.back ?? item?.answer;
      return typeof front === 'string' && typeof back === 'string' ? [{ front, back }] : [];
    });
  } catch {
    return [];
  }
}

/** First few Markdown blocks, cut at a paragraph boundary so math and lists stay intact. */
function excerpt(markdown: string, limit: number) {
  const blocks = markdown.trim().split(/\n{2,}/);
  let out = '';
  for (const block of blocks) {
    if (out && out.length + block.length > limit) break;
    out += (out ? '\n\n' : '') + block;
  }
  return out;
}

/** Some generated prompts are bare LaTeX, like `\\text{Solve } x + 5 = 12`. Wrap those as inline math so KaTeX renders them. */
function prompt(text: string) {
  return /\\[a-zA-Z]+/.test(text) && !/\$|\\\(|\\\[/.test(text) ? `$${text.trim()}$` : text;
}

/** Small, non-interactive look at the resource's real content for the grid card. */
function CardPreview({ resource }: { resource: Resource }) {
  const first = resource.questions[0];
  switch (resource.kind) {
    case 'quiz':
      return first ? (
        <div className="card-preview card-preview--quiz">
          <span className="card-preview__label">Q1</span>
          <Markdown>{prompt(excerpt(first.prompt, 240))}</Markdown>
        </div>
      ) : <p className="preview-empty">No questions</p>;
    case 'test':
      return resource.questions.length ? (
        <div className="card-preview card-preview--paper">
          <ol>
            {resource.questions.slice(0, 2).map((question) => (
              <li key={question.id}>
                <Markdown>{prompt(excerpt(question.prompt, 160))}</Markdown>
                <span className="card-preview__marks">[{question.marks}]</span>
              </li>
            ))}
          </ol>
        </div>
      ) : <p className="preview-empty">LaTeX only</p>;
    case 'flashcards': {
      const card = readCards(resource)[0];
      return card ? (
        <div className="card-preview card-preview--card">
          <Markdown>{prompt(excerpt(card.front, 200))}</Markdown>
        </div>
      ) : <p className="preview-empty">No cards</p>;
    }
    case 'notes':
      return resource.content.trim() ? (
        <div className="card-preview card-preview--notes">
          <Markdown>{excerpt(resource.content, 600)}</Markdown>
        </div>
      ) : <p className="preview-empty">Empty notes</p>;
    case 'diagram':
      return (
        <div className="card-preview card-preview--diagram">
          <DiagramFrame resource={resource} thumbnail />
        </div>
      );
  }
}

function count(resource: Resource) {
  if (resource.kind === 'flashcards') {
    const cards = readCards(resource).length;
    return cards ? plural(cards, 'card') : '';
  }
  return resource.questions.length ? plural(resource.questions.length, 'question') : '';
}

/**
 * Grid card. The title button opens the resource and stretches over the card;
 * the Preview button sits above it as a sibling, so no button is nested in another.
 */
export function InlineResourcePreview({ resource, onPreview }: { resource:Resource;onPreview:()=>void }) {
  const { navigate } = useApp();
  if (resource.kind !== 'diagram') return <ResourceCard resource={resource} onPreview={onPreview} />;
  return <article className="thread-resources__diagram"><header><button type="button" onClick={() => navigate({kind:'resource',resourceId:resource.id})}>{resource.title}</button><button type="button" className="link-button" onClick={() => navigate({kind:'resource',resourceId:resource.id})}>View resource</button><OpenDiagramButton resource={resource} compact /></header><DiagramFrame resource={resource} /></article>;
}

export function ResourceCard({ resource, onPreview }: { resource: Resource; onPreview: () => void }) {
  const { navigate } = useApp();
  const Icon = kindIcons[resource.kind];
  const meta = [count(resource), timeAgo(resource.createdAt)].filter(Boolean).join(', ');
  return (
    <article className={`resource-card resource-card--${resource.kind}`}>
      <div className="resource-card__top">
        <span className="resource-card__kind"><Icon size={13} aria-hidden /> {resource.connectedFile ? connectorCatalog.find(item => item.id === resource.connectedFile?.connector)?.name : kindLabels[resource.kind]}</span>
        {resource.completedAt ? <span className="resource-card__done" title="Done"><Check size={12} aria-label="Done" /></span> : null}
        <DeleteResource resource={resource} compact />
        <button type="button" className="resource-card__peek" onClick={onPreview} aria-label={`Preview ${resource.title}`} title="Preview">
          <Eye size={14} aria-hidden />
        </button>
      </div>
      <div className="resource-card__preview" inert aria-hidden>
        <CardPreview resource={resource} />
      </div>
      <button type="button" className="resource-card__open" onClick={() => navigate({ kind: 'resource', resourceId: resource.id })}>
        <span className="resource-card__title">{resource.title}</span>
      </button>
      <span className="resource-card__meta">{meta}</span>
    </article>
  );
}

function PreviewBody({ resource }: { resource: Resource }) {
  if (resource.connectedFile) return <ConnectedFileView key={resource.id} resource={resource} />;
  switch (resource.kind) {
    case 'quiz': {
      const shown = resource.questions.slice(0, 5);
      if (!shown.length) return <p className="muted">This quiz has no questions.</p>;
      return (
        <>
          <ol className="preview-questions">
            {shown.map((question) => <li key={question.id}><Markdown>{prompt(question.prompt)}</Markdown></li>)}
          </ol>
          {resource.questions.length > shown.length ? <p className="muted">{plural(resource.questions.length - shown.length, 'more question')} in the full quiz.</p> : null}
        </>
      );
    }
    case 'test': {
      if (!resource.questions.length) return <pre className="source">{resource.content || 'No LaTeX was returned for this test.'}</pre>;
      return <PaperPreview resource={resource} />;
    }
    case 'flashcards': {
      const cards = readCards(resource);
      if (!cards.length) return <p className="muted">Centre couldn&rsquo;t read these cards.</p>;
      const shown = cards.slice(0, 8);
      return (
        <>
          <ul className="preview-cards">
            {shown.map((card, index) => (
              <li key={index}>
                <div className="preview-cards__front"><Markdown>{prompt(card.front)}</Markdown></div>
                <div className="preview-cards__back"><Markdown>{prompt(card.back)}</Markdown></div>
              </li>
            ))}
          </ul>
          {cards.length > shown.length ? <p className="muted">{plural(cards.length - shown.length, 'more card')} in the deck.</p> : null}
        </>
      );
    }
    case 'notes':
      return resource.content.trim() ? <article className="notes"><Markdown>{resource.content}</Markdown></article> : <p className="muted">These notes are empty.</p>;
    case 'diagram':
      return <div className="preview-dialog__diagram"><DiagramFrame resource={resource} /></div>;
  }
}

export function ResourcePreviewDialog({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const { navigate } = useApp();
  const Icon = kindIcons[resource.kind];
  const meta = [count(resource), `made ${timeAgo(resource.createdAt)}`].filter(Boolean).join(', ');
  return (
    <Dialog
      title={resource.title}
      description={<span className="dialog__kind"><Icon size={13} aria-hidden /> {resource.connectedFile ? connectorCatalog.find(item => item.id === resource.connectedFile?.connector)?.name : kindLabels[resource.kind]}, {meta}</span>}
      onClose={onClose}
      size="lg"
      className="preview-dialog"
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose}>Close</button>
          <button
            type="button"
            className="button button--primary"
            data-autofocus
            onClick={() => {
              onClose();
              navigate({ kind: 'resource', resourceId: resource.id });
            }}
          >
            Open resource <ArrowUpRight size={14} aria-hidden />
          </button>
        </>
      }
    >
      <PreviewBody resource={resource} />
    </Dialog>
  );
}

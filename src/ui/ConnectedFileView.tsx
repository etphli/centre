import { useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import type { Resource } from '../../shared/schema';
import { connectorCatalog } from '../../shared/connectors';
import { connectedFileUrl } from '../../shared/connected-files';
import { api, openExternal } from '../data/client';
import { useApp } from './context';
import { timeAgo } from './format';
import './connected-file.css';

export function ConnectedFileView({ resource }: { resource: Resource }) {
  const { act } = useApp();
  const [mode, setMode] = useState<'centre' | 'google'>('centre');
  const [page, setPage] = useState(0);
  const [sheet, setSheet] = useState(0);
  const [busy, setBusy] = useState(false);
  const file = resource.connectedFile;
  if (!file) return null;
  const service = connectorCatalog.find(item => item.id === file.connector);
  const url = connectedFileUrl(file.connector, file.fileId);
  const embed = file.connector === 'google-docs' ? url.replace(/\/edit$/, '/preview') : file.connector === 'google-sheets' ? url.replace(/\/edit$/, '/preview') : file.connector === 'google-slides' ? url.replace(/\/edit$/, '/embed') : null;
  const currentSlide = file.slides[Math.min(page, file.slides.length - 1)];
  const currentSheet = file.sheets[Math.min(sheet, file.sheets.length - 1)];
  async function refreshFile() {
    setBusy(true);
    await act(() => api.refreshConnectedFile(resource.id), 'Updated from source');
    setBusy(false);
  }
  return <section className="connected-file" aria-label={`${service?.name ?? 'Connected file'} viewer`}>
    <header className="connected-file__toolbar"><div className="connected-file__source"><span className="connected-file__dot" style={{ background: service?.color }} /><span>{service?.name}</span><span className="connected-file__sync">Updated {timeAgo(file.syncedAt)}</span></div><div className="connected-file__actions"><button type="button" className="button button--quiet button--small" disabled={busy} onClick={() => void refreshFile()}><RefreshCw size={13} className={busy ? 'spin' : undefined} />{busy ? 'Refreshing' : 'Refresh'}</button><button type="button" className="icon-button" aria-label={`Open original in ${service?.name}`} title="Open original" onClick={() => void openExternal(url)}><ExternalLink size={14} /></button></div></header>
    {embed ? <div className="connected-file__modes" role="group" aria-label="File view"><button type="button" aria-pressed={mode === 'centre'} onClick={() => setMode('centre')}>Centre view</button><button type="button" aria-pressed={mode === 'google'} onClick={() => setMode('google')}>Google preview</button></div> : null}
    {mode === 'google' && embed ? <div className="connected-file__embed"><p>Google preview uses your browser’s access to this file. If it asks you to sign in or cannot load, use Centre view.</p><iframe src={embed} title={resource.title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" /></div> : file.connector === 'google-sheets' ? <>
      <div className="connected-file__range">{file.range ?? 'A1:Z100'} <span>Saved cell values. Ask Centre to read another range or edit cells.</span></div>
      <div className="connected-sheet" tabIndex={0} aria-label="Spreadsheet cells">{currentSheet && currentSheet.rows.length ? <table><thead><tr><th aria-label="Row number" />{Array.from({ length: Math.max(...currentSheet.rows.map(row => row.length)) }, (_, index) => <th key={index} scope="col">{columnName((currentSheet?.startColumn ?? 0) + index)}</th>)}</tr></thead><tbody>{currentSheet.rows.map((row, rowIndex) => <tr key={rowIndex}><th scope="row">{rowIndex + 1 + currentSheet.startRow}</th>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table> : <p className="connected-file__empty">No cell values in this range.</p>}</div>
      <div className="connected-sheet__tabs" role="group" aria-label="Sheets">{file.sheets.map((item, index) => <button type="button" key={index} aria-pressed={sheet === index} onClick={() => setSheet(index)}>{item.title}</button>)}</div>
    </> : file.connector === 'google-slides' ? <div className="connected-slides">
      <div className="connected-slide"><span className="connected-slide__number">{page + 1} / {file.slides.length || 1}</span><div>{currentSlide?.text || 'This slide contains visual elements. Use Google preview to see the original layout.'}</div></div>
      <nav aria-label="Slides"><button type="button" className="icon-button" aria-label="Previous slide" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></button><span>Slide {Math.min(page + 1, file.slides.length) || 1} of {file.slides.length || 1}</span><button type="button" className="icon-button" aria-label="Next slide" disabled={page >= file.slides.length - 1} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></button></nav>
    </div> : <article className="connected-document"><h2>{resource.title}</h2><div>{resource.content || 'No readable text was returned. Open the original to see images or other file content.'}</div></article>}
    <footer className="connected-file__hint">Ask Centre to review this file or make a specific edit. Refresh to see changes from the original. Saved content is available offline.</footer>
  </section>;
}

function columnName(index:number) { let name = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name; }

import { memo, useEffect, useState } from 'react';

type Content = typeof import('./MarkdownContent')['default'];
type LoadedContent = { status:'loading' } | { status:'ready'; Content:Content } | { status:'error'; error:unknown };
let loadedContent: Content | undefined;
let loadingContent: Promise<Content> | undefined;

export function preloadMarkdown() {
  loadingContent ??= import('./MarkdownContent').then(module => {
    loadedContent = module.default;
    return module.default;
  }).catch(error => {
    loadingContent = undefined;
    throw error;
  });
  return loadingContent;
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const [loaded,setLoaded] = useState<LoadedContent>(() => loadedContent ? { status:'ready',Content:loadedContent } : { status:'loading' });
  useEffect(() => {
    if (loaded.status !== 'loading') return;
    let active = true;
    void preloadMarkdown().then(Content => {
      if (active) setLoaded({ status:'ready',Content });
    },error => { if (active) setLoaded({ status:'error',error }); });
    return () => { active = false; };
  },[loaded.status]);
  if (loaded.status === 'error') throw loaded.error;
  if (loaded.status === 'loading') return <div className="markdown" role="status" aria-label="Loading content"><span className="spinner spinner--small" /></div>;
  return <loaded.Content>{children}</loaded.Content>;
});

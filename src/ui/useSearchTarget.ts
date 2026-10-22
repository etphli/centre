import { useEffect } from 'react';
import { useApp } from './context';

export function useSearchTarget(id: string | undefined) {
  const { navigationId } = useApp();
  useEffect(() => {
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    const clear = () => target.classList.remove('search-target');
    const frame = requestAnimationFrame(() => {
      target.classList.add('search-target');
      target.scrollIntoView({ block: 'center' });
      window.addEventListener('pointerdown', clear, { once: true });
      window.addEventListener('keydown', clear, { once: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      clear();
      window.removeEventListener('pointerdown', clear);
      window.removeEventListener('keydown', clear);
    };
  }, [id, navigationId]);
}

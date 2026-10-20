import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import './select.css';

interface Option { value: string; label: string }
interface SelectProps { value: string; options: readonly Option[]; onChange: (value: string) => void; label: string; disabled?: boolean; compact?: boolean }

export function Select({ value, options, onChange, label, disabled, compact }: SelectProps) {
  const [open,setOpen] = useState(false);
  const [active,setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({text:'',at:0});
  const id = useId();
  const selected = options.find(option => option.value === value);
  function close() { setOpen(false); }
  function choose(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    close(); trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const panel = menu.current;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const height = Math.min(options.length * 30 + 10,280);
      const above = window.innerHeight - rect.bottom < height + 10 && rect.top > window.innerHeight - rect.bottom;
      const width = Math.min(Math.max(rect.width,compact ? 210 : 180),window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.min(Math.max(12,rect.left),window.innerWidth-width-12)}px`;
      panel.style.top = `${above ? Math.max(8,rect.top-height-4) : rect.bottom+4}px`;
      panel.style.maxHeight = `${above ? Math.min(height,rect.top-12) : Math.min(height,window.innerHeight-rect.bottom-12)}px`;
    };
    panel.showPopover(); place();
    window.addEventListener('resize',place); document.addEventListener('scroll',place,true);
    return () => { panel.hidePopover(); window.removeEventListener('resize',place); document.removeEventListener('scroll',place,true); };
  },[open,options.length,compact]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown',outside);
    return () => document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'}); },[active,open,id]);
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setActive(Math.max(0,options.findIndex(option => option.value === value))); setOpen(true); return; }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active); else { setActive(Math.max(0,options.findIndex(option => option.value === value))); setOpen(true); }
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      search.current = {text:(Date.now()-search.current.at > 700 ? '' : search.current.text)+event.key.toLowerCase(),at:Date.now()};
      const index = options.findIndex(option => option.label.toLowerCase().startsWith(search.current.text));
      if (index >= 0) { setActive(index); setOpen(true); }
    }
  }
  return <div className={`centre-select${compact ? ' centre-select--compact' : ''}`} ref={root}>
    <button type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined} className="centre-select__trigger" disabled={disabled || !options.length} ref={trigger} onKeyDown={keyboard} onBlur={close} onClick={() => { setActive(Math.max(0,options.findIndex(option => option.value === value))); setOpen(current => !current); }}><span>{selected?.label ?? 'Choose…'}</span><ChevronDown size={12} /></button>
    {open ? <div ref={menu} popover="manual" role="listbox" aria-label={label} id={id} className="centre-select__menu">{options.map((option,index) => <div role="option" id={`${id}-${index}`} key={option.value} aria-selected={option.value === value} className={`centre-select__option${active === index ? ' is-highlighted' : ''}`} onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); choose(index); }}><span>{option.label}</span>{option.value === value ? <Check size={12} /> : null}</div>)}</div> : null}
  </div>;
}

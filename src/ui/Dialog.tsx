import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** When false, Escape and backdrop clicks are ignored (for example while a request runs). */
  dismissible?: boolean;
  className?: string;
  hideHeader?: boolean;
}

/** Modal built on the native dialog element, which handles focus trapping and inert backgrounds. */
export function Dialog({ title, description, onClose, children, footer, size = 'md', dismissible = true, className, hideHeader }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    returnFocus.current = document.activeElement;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus]:not(:disabled), .dialog__body input:not([type="radio"]), .dialog__body select, .dialog__body textarea, .dialog__body button')?.focus();
    }
    return () => {
      dialog?.close();
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div className="dialog__inner">
        <header className={hideHeader ? 'visually-hidden' : 'dialog__header'}>
          <h2 id={titleId} className="dialog__title">{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={!dismissible}>
            <X size={16} />
          </button>
        </header>
        {description ? <p id={descriptionId} className="dialog__description">{description}</p> : null}
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

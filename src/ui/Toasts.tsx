import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { ToastInput } from './types';

export interface Toast extends ToastInput {
  id: number;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toast.tone === 'error' ? 12_000 : toast.action ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  return (
    <div className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <p className="toast__message">{toast.message}</p>
      {toast.action ? (
        <button
          type="button"
          className="button button--quiet button--small"
          onClick={() => {
            toast.action?.run();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="icon-button icon-button--small" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

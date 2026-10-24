import { createContext, useContext, useEffect, useRef } from 'react';
import type { WorkspaceState } from '../domain/contracts';

export type ClientState = WorkspaceState & { csrfToken: string; evaluations: import('../domain/contracts').Evaluation[] };
export interface WorkspaceContextValue { state: ClientState; mutate: (path: string, body?: unknown) => Promise<unknown>; refresh: () => Promise<void>; notify: (message: string) => void }
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() { const value = useContext(WorkspaceContext); if (!value) throw new Error('Workspace is not ready'); return value; }
export function useDialog(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialogs = document.querySelectorAll<HTMLElement>('.modal, .goal-drawer');
    const dialog = dialogs[dialogs.length - 1];
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || [])].filter(element => element.offsetParent !== null);
    if (dialog && !dialog.contains(document.activeElement)) focusable()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      const activeDialogs = document.querySelectorAll<HTMLElement>('.modal, .goal-drawer');
      if (activeDialogs[activeDialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
}

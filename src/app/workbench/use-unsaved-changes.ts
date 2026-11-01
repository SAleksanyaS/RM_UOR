import { useCallback, useEffect, useRef } from 'react';
import { confirmDiscardChanges, useWorkbenchLeaveGuard } from './context';

/** Protect edits across local close, workbench navigation and browser unload. */
export function useUnsavedChanges(dirty: boolean): (action: () => void) => boolean {
  const current = useRef(dirty); current.current = dirty;
  const register = useWorkbenchLeaveGuard();
  useEffect(() => register?.(() => current.current), [register]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return useCallback((action: () => void) => {
    if (current.current && !confirmDiscardChanges()) return false;
    action();
    return true;
  }, []);
}

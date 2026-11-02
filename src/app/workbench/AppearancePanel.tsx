import { CommandRecoveryError } from './command-recovery';
import { useEffect, useRef, useState } from 'react';
import { X, Palette } from 'lucide-react';
import { useWorkbench, type VisualPreferences } from './context';
import { useUnsavedChanges } from './use-unsaved-changes';
import { workbenchErrorMessage } from './WorkbenchShell';

/** The same personal editor is available from every page and from Settings. */
export function AppearancePanel({ onClose }: { onClose?: () => void }) {
  const { preferences, saveAppearance, recoverAppearance, retryAppearance, appearanceRecovery, appearancePending } = useWorkbench();
  const [edited, setEdited] = useState<Partial<VisualPreferences>>({});
  const visual: VisualPreferences = {
    theme: 'system', density: 'comfortable', sidebar: 'expanded',
    ...preferences?.values.visual, ...edited,
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const panel = useRef<HTMLDivElement>(null), live = useRef(true);
  const saveButton = useRef<HTMLButtonElement>(null), restoreSaveFocus = useRef(false);
  const leave = useUnsavedChanges(Object.keys(edited).length > 0);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (onClose) panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  useEffect(() => {
    if (busy || !restoreSaveFocus.current) return;
    restoreSaveFocus.current = false;
    // Chromium can move focus to body when the active button becomes disabled.
    // Restore only that lost focus, never steal it from another chosen control.
    if (document.activeElement === document.body) saveButton.current?.focus();
  }, [busy]);

  const save = async () => {
    if (busy) return;
    restoreSaveFocus.current = document.activeElement === saveButton.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      if (appearancePending) {
        const read = await (appearanceRecovery === 'not_found' ? retryAppearance() : recoverAppearance());
        if (!live.current) return;
        // Recovery may belong to another editor. Only acknowledge this form if
        // its edited fields are present in the authoritative saved snapshot.
        if (!read || Object.entries(edited).some(([key, value]) => read.values.visual[key as keyof VisualPreferences] !== value)) {
          setError(new CommandRecoveryError('Предыдущее сохранение проверено. Изменения этой формы ещё не сохранены.'));
          return;
        }
      } else {
        await saveAppearance(edited);
      }
      if (live.current) { setEdited({}); setSaved(true); }
    } catch (failure) {
      if (live.current) setError(failure);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const change = (patch: Partial<VisualPreferences>) => { setEdited(value => ({ ...value, ...patch })); setSaved(false); };
  const actionLabel = busy ? 'Сохраняем…' : !appearancePending ? 'Сохранить личный вид'
    : appearanceRecovery === 'not_found' ? 'Повторить исходное сохранение личного вида' : 'Проверить сохранение личного вида';

  return <div ref={panel} className="wb-appearance wb-surface" role={onClose ? 'dialog' : undefined} aria-modal={onClose ? true : undefined} aria-label="Внешний вид" onKeyDown={event => {
    if (!onClose) return;
    if (event.key === 'Escape') { event.preventDefault(); leave(onClose); }
    if (event.key === 'Tab') {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled])') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="wb-section-header">
      <div><span className="wb-eyebrow"><Palette size={15} />Личное представление</span><h2>Внешний вид</h2></div>
      {onClose && <button type="button" className="wb-icon-button" aria-label="Закрыть внешний вид" onClick={() => leave(onClose)}><X size={20} /></button>}
    </header>
    <div className="wb-object-content">
      <p className="wb-muted">Настройте удобный рабочий экран. Общие данные и методика не изменятся.</p>
      <fieldset disabled={busy || appearancePending} className="wb-appearance-fields">
        <legend className="wb-visually-hidden">Настройки представления</legend>
        <label className="wb-field">Тема
          <select aria-label="Тема" value={visual.theme} onChange={event => change({ theme: event.target.value as VisualPreferences['theme'] })}>
            <option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option>
          </select>
        </label>
        <label className="wb-field">Плотность представления
          <select aria-label="Плотность представления" value={visual.density} onChange={event => change({ density: event.target.value as VisualPreferences['density'] })}>
            <option value="comfortable">Обычная</option><option value="compact">Компактная</option>
          </select>
        </label>
        <label className="wb-field">Боковое меню
          <select aria-label="Боковое меню" value={visual.sidebar ?? 'expanded'} onChange={event => change({ sidebar: event.target.value as VisualPreferences['sidebar'] })}>
            <option value="expanded">Раскрытое</option><option value="compact">Компактное</option>
          </select>
        </label>
      </fieldset>
      <div className="wb-form-actions"><button ref={saveButton} className="wb-primary-button" disabled={busy} onClick={() => void save()}>{actionLabel}</button></div>
      {error !== null && <p role="alert" className="wb-inline-feedback">{workbenchErrorMessage(error)}</p>}
      {saved && <p role="status" className="wb-success-note">Личный вид сохранён</p>}
    </div>
  </div>;
}

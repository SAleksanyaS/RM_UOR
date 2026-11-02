import { useState } from 'react';
import { Star } from 'lucide-react';
import { personalFavoriteKey, type PersonalObjectFavorite } from '../../domain/workbench/entities/preferences';
import { useWorkbench } from './context';

/** Callers pass objects already read through their authorized feature query. */
export function PersonalFavoriteButton({ favorite, label }: { favorite: PersonalObjectFavorite; label: string }) {
  const { preferences, loading, saveNavigation, appearancePending, appearanceRecovery, recoverAppearance, retryAppearance } = useWorkbench();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const selected = preferences?.values.navigation?.favorites.some(item => personalFavoriteKey(item) === personalFavoriteKey(favorite)) ?? false;
  const save = async (recover = false) => {
    setBusy(true); setError('');
    try {
      if (recover) await (appearanceRecovery === 'not_found' ? retryAppearance() : recoverAppearance());
      else await saveNavigation({ kind: 'favorite', path: favorite });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить избранное'); }
    finally { setBusy(false); }
  };
  return <div className="wb-object-favorite">
    <button type="button" disabled={busy || loading || !preferences || appearancePending} aria-pressed={selected}
      aria-label={(selected ? 'Убрать из избранного: ' : 'В избранное: ') + label} onClick={() => void save()}>
      <Star size={17} aria-hidden="true" fill={selected ? 'currentColor' : 'none'} /><span>{selected ? 'В избранном' : 'В избранное'}</span>
    </button>
    {error && <p role="alert">{error}</p>}
    {appearancePending && <button disabled={busy} onClick={() => void save(true)}>{appearanceRecovery === 'not_found' ? 'Повторить исходное сохранение настроек' : 'Проверить сохранение настроек'}</button>}
  </div>;
}

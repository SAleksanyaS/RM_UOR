import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import { EvidenceUpload } from './EvidenceUpload';

/** Parent keys this form by goal, leader and evaluation fingerprint. */
export function AchievementConfirmation({ goalId, leaderId, fingerprint }: { goalId: string; leaderId: string | null; fingerprint: string }) {
  const { mutate, notify } = useWorkspace();
  const [comment, setComment] = useState(''), [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function confirm() {
    setBusy(true); setError('');
    try { await mutate('/api/confirm', { goalId, leaderId, baseFingerprint: fingerprint, comment: comment.trim() || null, evidenceIds }); notify('Выполнение подтверждено куратором УОР'); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  return <section className="validation-card"><ShieldCheck size={22}/><div><h3>Выполнение ожидает подтверждения</h3><p>Проверьте результат и добавьте содержательный комментарий или подтверждающий файл. Подтверждение относится к этому составу и периоду.</p><textarea aria-label="Обоснование подтверждения" disabled={busy || uploading} placeholder="На основании чего подтверждаете результат…" rows={3} value={comment} onChange={event => setComment(event.target.value)}/><EvidenceUpload disabled={busy} onChange={setEvidenceIds} onUploadingChange={setUploading}/>{error && <p role="alert" className="error-inline">{error}</p>}<button className="button primary" disabled={busy || uploading || (comment.trim().replace(/\s+/g, ' ').length < 10 && !evidenceIds.length)} onClick={() => void confirm()}>{busy ? 'Подтверждаем…' : 'Подтвердить выполнение'}</button></div></section>;
}

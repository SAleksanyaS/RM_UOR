import { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import type { Evidence } from '../../domain/contracts';
import './evidence-upload.css';

const MAX_BYTES = 5_000_000;
type SelectedEvidence = Pick<Evidence, 'id' | 'name' | 'size'>;
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const data = String(reader.result ?? ''), divider = data.indexOf(','); if (divider < 0) reject(new Error('Не удалось прочитать файл')); else resolve(data.slice(divider + 1)); };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл')); reader.readAsDataURL(file);
  });
}
function fileSize(size: number) {
  return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('ru', { maximumFractionDigits: 1 })} КБ` : `${(size / (1024 * 1024)).toLocaleString('ru', { maximumFractionDigits: 1 })} МБ`;
}
export function EvidenceUpload({ onChange, disabled = false, onUploadingChange }: { onChange: (evidenceIds: string[]) => void; disabled?: boolean; onUploadingChange?: (uploading: boolean) => void }) {
  const { state, mutate } = useWorkspace();
  const [evidence, setEvidence] = useState<SelectedEvidence[]>([]), [uploadingName, setUploadingName] = useState(''), [errors, setErrors] = useState<string[]>([]);
  const active = useRef(true), uploading = useRef(false), selected = useRef<SelectedEvidence[]>([]);
  const callbacks = useRef({ onChange, onUploadingChange }); callbacks.current = { onChange, onUploadingChange };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (state.session.role !== 'curator') return <p className="muted">Прикрепление доказательств доступно куратору УОР.</p>;
  const busy = uploadingName !== '';
  function select(next: SelectedEvidence[]) { selected.current = next; setEvidence(next); callbacks.current.onChange(next.map(item => item.id)); }
  async function upload(files: File[]) {
    if (disabled || uploading.current || state.session.role !== 'curator' || !files.length) return;
    uploading.current = true; setErrors([]); callbacks.current.onUploadingChange?.(true);
    const nextErrors: string[] = [];
    try {
      for (const file of files) {
        if (!active.current) break;
        if (!file.size || file.size > MAX_BYTES || file.name.length > 200) {
          nextErrors.push(`${file.name}: ${!file.size ? 'файл пуст' : file.size > MAX_BYTES ? 'размер превышает 5 МБ' : 'имя длиннее 200 символов'}`); setErrors([...nextErrors]); continue;
        }
        setUploadingName(file.name);
        try {
          const base64 = await fileBase64(file); if (!active.current) break;
          const result = await mutate('/api/evidence', { name: file.name, base64 }) as { evidence: SelectedEvidence };
          if (!active.current) break;
          select([...selected.current, result.evidence]);
        } catch (error) { if (active.current) { nextErrors.push(`${file.name}: ${(error as Error).message}`); setErrors([...nextErrors]); } }
      }
    } finally {
      uploading.current = false;
      if (active.current) { setUploadingName(''); callbacks.current.onUploadingChange?.(false); }
    }
  }
  return <section className="evidence-upload" aria-label="Доказательства выполнения"><div className="evidence-upload-heading"><strong>Доказательства</strong><span>До 5 МБ на файл</span></div><label className={`evidence-upload-control ${disabled || busy ? 'disabled' : ''}`}><Paperclip size={16}/><span>Прикрепить файлы</span><input aria-label="Прикрепить доказательства" type="file" multiple disabled={disabled || busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files); }}/></label>
    {busy && <p className="evidence-upload-status" role="status">Загружаем {uploadingName}…</p>}
    {evidence.length > 0 && <ul className="evidence-upload-list">{evidence.map(item => <li key={item.id}><Paperclip size={14}/><span className="evidence-upload-name">{item.name}</span><small>{fileSize(item.size)}</small><button className="icon-button" aria-label={`Убрать ${item.name} из выбора`} title="Убрать из подтверждения" disabled={disabled || busy} onClick={() => select(selected.current.filter(value => value.id !== item.id))}><X size={15}/></button></li>)}</ul>}
    {errors.length > 0 && <div role="alert" className="error-inline">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    <p className="evidence-upload-help">Файлы прикрепятся к подтверждению после его сохранения. Удаление из списка убирает файл только из выбора.</p>
  </section>;
}

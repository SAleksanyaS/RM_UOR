import type { RestorePreviewResult } from './contracts';
export function RestorePreview({preview,confirmed,onConfirm,onApply,disabled}:{preview:RestorePreviewResult;confirmed:boolean;onConfirm(value:boolean):void;onApply():void;disabled:boolean}) {
 return <section aria-label="Предпросмотр восстановления" className="wb-maintenance-card">
  <h3>Проверенный архив</h3><p>Записей: {preview.counts.records}; файлов: {preview.counts.files}</p>
  <p>Восстановление полностью заменит текущие данные содержимым архива.</p>
  <p>{preview.currentEmpty?'Текущее рабочее место пусто; защитная копия не требуется.':'До замены будет создана проверенная защитная копия текущего рабочего места. Она останется в списке копий.'}</p>
  <p>Проверка действительна до {new Date(preview.expiresAt).toLocaleString('ru-RU')}. Изменение данных потребует нового предпросмотра.</p>
  {preview.warnings.map((warning,index)=><p role="status" key={index}>{warning.message} ({warning.code})</p>)}
  <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event=>onConfirm(event.target.checked)} /> Подтверждаю замену текущих данных архивом</label>
  <button type="button" disabled={disabled||!confirmed} onClick={onApply}>Заменить данные</button>
 </section>;
}

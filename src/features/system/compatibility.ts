import { z } from 'zod';
import { APP_VERSION, RELEASE_FORMAT_VERSION } from '../../domain/app-version';
const features = ['measurement-v1','tabular-v1','leaders-v1','knowledge-v1','execution-v1','connectors-v1','report-templates-v1','historical-organization-v1','maturity-template-v1','execution-journal-v1'] as const;
export const manifestSchema = z.object({ formatVersion: z.number().int().positive(), minimumApplicationVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  applicationVersion: z.string().regex(/^\d+\.\d+\.\d+$/), requiredFeatures: z.array(z.string().min(1).max(100)).max(100) }).strict();
export function versionAtLeast(current: string, required: string) {
  const a=current.split('.').map(Number),b=required.split('.').map(Number);
  if(a.length!==3||b.length!==3||[...a,...b].some(n=>!Number.isSafeInteger(n)||n<0))return false;
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return true;
}
export function createReleaseManifest() { return { formatVersion:RELEASE_FORMAT_VERSION, minimumApplicationVersion:APP_VERSION, applicationVersion:APP_VERSION,requiredFeatures:[...features] }; }
export function assertCompatibleRelease(files: Record<string,string>) {
  if(!files['catalog/manifest.json'])return; // Explicit compatibility with the pre-manifest local pilot.
  let raw:unknown;try{raw=JSON.parse(files['catalog/manifest.json']);}catch{throw new Error('Общий manifest повреждён. Предыдущие данные сохранены.');}
  const parsed=manifestSchema.safeParse(raw);if(!parsed.success)throw new Error('Некорректный manifest общей версии. Обновите программу или исправьте выпуск.');
  const m=parsed.data;
  if(m.formatVersion!==RELEASE_FORMAT_VERSION||!versionAtLeast(APP_VERSION,m.minimumApplicationVersion))throw new Error(`Для общей версии обновите приложение до ${m.minimumApplicationVersion}. Получите код, выполните npm ci и перезапустите npm run dev. Предыдущие данные сохранены.`);
  const unknown=m.requiredFeatures.filter(f=>!(features as readonly string[]).includes(f));if(unknown.length)throw new Error(`В общей версии есть неподдержанные возможности: ${unknown.join(', ')}. Обновите приложение.`);
}

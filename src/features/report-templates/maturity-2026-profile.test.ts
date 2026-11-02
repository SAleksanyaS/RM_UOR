import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import JSZip from 'jszip';
import { inspectTemplate } from './ooxml';
import { recognizeMaturity2026Template,suggestMaturity2026Profile,inspectMaturity2026Template } from './maturity-2026-profile';
import { renderMaturity2026Template } from './maturity-2026-render';
import {loadMaturityMaterials,createMaturitySnapshot} from '../maturity/workbench-materials';
it('recognizes the actual ten-slide family and dynamically renders editable values without GigaCode',async()=>{
 const bytes=readFileSync('materials/maturity/2026-10-30/source.pptx'),inspection=await inspectMaturity2026Template(bytes);
 expect(recognizeMaturity2026Template(inspection)).toBe(true);const profile=suggestMaturity2026Profile(inspection)!;
 const s=createMaturitySnapshot(loadMaturityMaterials());s.period='2026-11-06';s.leaders[0].name='Изменённый руководитель';s.teams[0].name='Изменённая команда';
 const output=await renderMaturity2026Template(bytes,profile,s),view=await inspectTemplate(output);
 expect(view.slides).toHaveLength(10);const text=view.slides.flatMap(s=>s.shapes.map(s=>s.text)).join('\n');
 expect(text).toContain('2026-11-06');expect(text).toContain('Изменённый руководитель');expect(text).toContain('Изменённая команда');expect(text).toContain('271/290');expect(text).toContain('Нет данных');expect(text).not.toContain('GigaCode');expect(text).not.toContain('Сидоров В.');
 const zip=await JSZip.loadAsync(output);expect(Object.values(zip.files).some(f=>!f.dir&&f.name.startsWith('ppt/media/'))).toBe(false);
});
it('paginates a longer leader roster while keeping each team visible',async()=>{
 const b=loadMaturityMaterials(),s=createMaturitySnapshot(b),bytes=readFileSync('materials/maturity/2026-10-30/source.pptx'),p=suggestMaturity2026Profile(await inspectMaturity2026Template(bytes))!;
 s.leaders[0].teamIds=[...s.teams.map(t=>t.id)];const view=await inspectTemplate(await renderMaturity2026Template(bytes,p,s));expect(view.slides.length).toBeGreaterThan(10);
});

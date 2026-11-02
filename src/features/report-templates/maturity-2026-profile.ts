import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { inspectTemplate,validateZipEnvelope,templatePackage } from './ooxml';
import { z } from 'zod';
import type { TemplateInspection } from './contracts';
export const maturity2026ProfileSchema=z.strictObject({kind:z.literal('dit-maturity-2026-10-v1'),name:z.string().min(1),rowsPerSlide:z.number().int().min(1).max(10).default(10),sourceLayout:z.literal('overview-leaders-eight-details')});
export type Maturity2026Profile=z.infer<typeof maturity2026ProfileSchema>;
export function recognizeMaturity2026Template(inspection:TemplateInspection):boolean{
 const has=(n:number,t:string)=>inspection.slides[n]?.shapes.some(s=>s.text.includes(t));
 return inspection.slides.length===10&&!!has(0,'Модель зрелости ДИТ')&&!!has(0,'Метрики в целеполагании')&&!!has(1,'Результат по каждому лидеру')&&inspection.slides.slice(2).every(s=>s.shapes.some(sh=>sh.text.includes('результат команд'))&&s.shapes.some(sh=>sh.text==='Команда')&&s.shapes.some(sh=>sh.text==='Что не выполнено: факт и цель'));
}
export function suggestMaturity2026Profile(inspection:TemplateInspection):Maturity2026Profile|null{return recognizeMaturity2026Template(inspection)?{kind:'dit-maturity-2026-10-v1',name:'Модель зрелости · 10 слайдов · октябрь 2026',rowsPerSlide:10,sourceLayout:'overview-leaders-eight-details'}:null;}

/** Printer preferences are inert but unnecessary; remove that one known family before strict inspection. */
export async function inspectMaturity2026Template(bytes:Buffer):Promise<TemplateInspection>{
 validateZipEnvelope(bytes);const zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
 const printer=/^ppt\/printerSettings\/printerSettings[1-9]\d*\.bin$/;
 const removed=Object.keys(zip.files).filter(p=>printer.test(p));
 if(!removed.length)return inspectTemplate(bytes);
 for(const p of removed)zip.remove(p);
 const R='http://schemas.openxmlformats.org/package/2006/relationships',T='http://schemas.openxmlformats.org/package/2006/content-types';
 for(const file of Object.values(zip.files).filter(f=>f.name.endsWith('.rels'))){const doc=templatePackage.xml(await file.async('text'));let changed=false;for(const rel of templatePackage.all(doc,R,'Relationship'))if(rel.getAttribute('Type')==='http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings'&&/^(?:\.\.\/)?printerSettings\/printerSettings[1-9]\d*\.bin$/.test(rel.getAttribute('Target')??'')){rel.parentNode!.removeChild(rel);changed=true;}if(changed)zip.file(file.name,templatePackage.serialize(doc));}
 const types=zip.file('[Content_Types].xml');if(types){const doc=templatePackage.xml(await types.async('text'));for(const n of templatePackage.all(doc,T,'Override'))if(removed.includes((n.getAttribute('PartName')??'').replace(/^\//,'')))n.parentNode!.removeChild(n);zip.file('[Content_Types].xml',templatePackage.serialize(doc));}
 const inspection=await inspectTemplate(await zip.generateAsync({type:'nodebuffer'}));return {...inspection,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,warnings:[...inspection.warnings,'Параметры принтера исключены из разбора; исходные байты сохранены.']};
}

import {sectionNames,type ReportDefinition} from './contracts';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function mergeReportDefinitions(base:ReportDefinition,mine:ReportDefinition,latest:ReportDefinition,choices:Record<string,'mine'|'latest'>={}){
 const conflicts:Array<{path:string;mine:unknown;latest:unknown}>=[];
 const changes:Array<{path:string;mine:unknown;latest:unknown;merged:unknown}>=[];
 const choose=(path:string,b:unknown,m:unknown,l:unknown):any=>{if(same(m,l)||same(b,l))return m;if(same(b,m))return l;conflicts.push({path,mine:m,latest:l});return choices[path]==='latest'?l:m;};
 const select=(path:string,b:unknown,m:unknown,l:unknown):any=>{const merged=choose(path,b,m,l);if(!same(b,m)||!same(b,l))changes.push({path,mine:m,latest:l,merged});return merged;};
 const merged=structuredClone(mine);
 for(const key of ['template','context','title','comment','period','teamIds'] as const)(merged as any)[key]=select(key,base[key],mine[key],latest[key]);
 const kinds=(d:ReportDefinition)=>d.sections.map(s=>s.kind);
 if(!same(kinds(base),kinds(mine))||!same(kinds(base),kinds(latest)))merged.sections=select('sections',base.sections,mine.sections,latest.sections);
 else merged.sections=mine.sections.map(s=>{const b=base.sections.find(v=>v.kind===s.kind)!,l=latest.sections.find(v=>v.kind===s.kind)!;return {...s,title:select('sections.'+s.kind+'.title',b.title,s.title,l.title),comment:select('sections.'+s.kind+'.comment',b.comment,s.comment,l.comment)};});
 return {merged,conflicts,changes,unresolved:conflicts.filter(c=>!choices[c.path])};
}

export function reportFieldLabel(path:string){const [field,kind,part]=path.split('.');if(field==='sections'&&kind)return (sectionNames[kind as keyof typeof sectionNames]??kind)+' · '+(part==='title'?'заголовок':'комментарий');return ({title:'Название отчёта',comment:'Комментарий отчёта',template:'Шаблон',context:'Цель, область и период',period:'Период',teamIds:'Команды',sections:'Состав и порядок разделов'} as Record<string,string>)[field]??field;}
export function reportFieldValue(path:string,value:unknown):string{
 if(value===null)return 'Не выбран';if(path==='template')return value==='goal-management-v1'?'Отчёт по цели':'Модель зрелости';
 if(Array.isArray(value))return value.length?value.map(v=>typeof v==='string'?v:v.title+(v.comment?' — '+v.comment:'')).join('; '):'Все команды';
 if(path==='context'){const c=value as NonNullable<ReportDefinition['context']>;return 'Цель '+(c.goalId??'не выбрана')+'; '+(c.resultMode==='agreed'?'согласованный':'текущий')+'; '+(c.time.kind==='as_of'?c.time.date:c.time.startInclusive+' — '+c.time.endExclusive)+'; область '+Object.values(c.scopePath).filter(Boolean).join(' / ');}
 return String(value||'Без текста');
}

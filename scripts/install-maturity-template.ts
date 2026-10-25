import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createContext} from '../src/server/workspace/context';
import {inspectTemplate} from '../src/features/report-templates/ooxml';
import {suggestedMaturityProfile} from '../src/features/report-templates/maturity-preset';
import {saveReportTemplate} from '../src/features/report-templates/service';
import type {StoredReportTemplate} from '../src/features/report-templates/contracts';
import type {Session} from '../src/domain/contracts';

/** Local administrative installation: no credentials, sessions or corporate files enter Git. */
const args=process.argv.slice(2);const option=(key:string)=>{const at=args.indexOf(key);return at<0?undefined:args[at+1];};
const templatePath=option('--template'),curatorId=option('--curator-id'),goalId=option('--goal-id');
if(!templatePath||!curatorId)throw Error('Укажите --template <исходный.pptx> --curator-id <идентификатор существующего куратора>; при необходимости --goal-id <идентификатор цели>');
const context=await createContext({projectRoot:resolve(option('--project-root')??process.cwd()),startupCheck:false});
try{
 const account=context.roles.listAccounts().find(item=>item.id===curatorId);if(!account)throw Error('Куратор не зарегистрирован на этом рабочем месте');
 const session:Session={id:randomUUID(),role:'curator',curatorId:account.id,name:account.name,createdAt:new Date().toISOString()};
 const catalog=await context.catalogs.readForSession(session),candidates=catalog.goals.filter(goal=>goalId?goal.id===goalId:/модел.*зрел|зрел.*модел/i.test(goal.title));
 if(candidates.length!==1)throw Error('Не удалось однозначно выбрать цель; передайте --goal-id');const goal=candidates[0];
 const existing=context.db.list<StoredReportTemplate>('report-templates').find(item=>item.ownerId===account.id&&item.profile.preset?.kind==='dit-maturity-v1'&&item.profile.preset.goalId===goal.id);
 if(existing){console.log(JSON.stringify({installed:true,changed:false,id:existing.id,name:existing.profile.name,message:'Личный полный профиль уже установлен. Изменения доступны в интерфейсе настройки шаблонов.'}));}
 else{
  const bytes=await readFile(resolve(templatePath)),inspection=await inspectTemplate(bytes),profile=suggestedMaturityProfile(inspection);if(!profile?.preset)throw Error('Структура PPTX не соответствует полному шаблону модели зрелости');
  profile.preset.goalId=goal.id;profile.preset.metricIds=goal.measurement?.metrics.map(metric=>metric.id)??goal.requiredMetricIds??[];
  profile.preset.leaderOrder=[...new Set(inspection.slides.slice(3).flatMap(slide=>{const name=slide.shapes.find(shape=>shape.text.includes('— результат команд'))?.text.split(' — ')[0].trim();return catalog.leaders.filter(leader=>leader.name===name).map(leader=>leader.id);}))];
  const saved=await saveReportTemplate(context,session,{baseRevision:null,base64:bytes.toString('base64'),profile});
  console.log(JSON.stringify({installed:true,changed:true,id:saved.id,name:saved.profile.name,message:'Личный полный профиль установлен. Войдите этим куратором и выберите его в разделе «Отчёты».'}));
 }
}finally{context.db.close();}

import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
import { PersonalOkoWorkspace } from '../../connectors/workbench/PersonalOkoWorkspace';
import type { OkoClient } from '../../connectors/workbench/client';
import { WorkbenchDataPage } from './WorkbenchDataPage';
import { RawProcessingSource } from './RawProcessingSource';
import { RawFilesPage } from './RawFilesPage';

export function DataWorkspace({personalClient}:{personalClient:OkoClient}){
 const {context,navigate}=useGlobalContext(),{session}=useWorkbench();
 const hash=window.location.hash;
 const lineage=new URLSearchParams(window.location.search);
 const active=hash==='#personal-oko'?'acquisition':hash==='#processing'?'processing':hash==='#goal-data'||lineage.has('fact')||lineage.has('result')?'goals':'files';
 return <section className="wb-data-workspace" aria-label="Работа с данными"><nav className="wb-data-subnav" aria-label="Разделы данных">
 <button aria-current={active==='files'?'page':undefined} onClick={()=>navigate('/data')}>Файлы</button>
 <button aria-current={active==='acquisition'?'page':undefined} onClick={()=>navigate('/data#personal-oko')}>Получение файлов</button>
 <button aria-current={active==='processing'?'page':undefined} onClick={()=>navigate('/data#processing')}>Обработка</button>
 <button aria-current={active==='goals'?'page':undefined} onClick={()=>navigate('/data#goal-data')}>Данные целей</button>
 </nav>
 {active==='files'&&<RawFilesPage key={session?.personId??'unassigned'}/>}
 <div hidden={active!=='acquisition'}><PersonalOkoWorkspace key={session?.personId??'unassigned'} client={personalClient} refreshKey={[session?.personId,session?.role,session?.policyState].join(':')}/></div>
 {active==='processing'&&lineage.get('raw')&&<RawProcessingSource id={lineage.get('raw')!}/>}
 {(active==='goals'||active==='processing')&&(context?<WorkbenchDataPage processing={active==='processing'} rawFileId={lineage.get('raw')??undefined}/>:<div className="wb-content-empty"><h2>Данные целей появятся после получения каталога</h2><p>Для получения и просмотра личных файлов каталог не нужен.</p><button onClick={()=>navigate('/data')}>Открыть исходные файлы</button></div>)}
 </section>;
}

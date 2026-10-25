import {archiveLocalHistory} from './local-history';

try{
 if(process.argv.length>2)throw new Error('Запуск: npm run history:archive. Сначала остановите приложение.');
 const result=await archiveLocalHistory({projectRoot:process.cwd()});
 console.log(`Журнал архивирован. Независимая полная копия базы: .runtime/history-archive/${result.id}/database.sqlite`);
 console.log(`Проверяемый манифест: .runtime/history-archive/${result.id}/manifest.json`);
 console.log('Цели, факты, черновики, подтверждения, отчёты, шаблоны и учётные записи сохранены. При следующем запуске видимый журнал начнётся заново.');
}catch(error){console.error(error instanceof Error?error.message:'Не удалось архивировать журнал. Рабочие данные сохранены.');process.exitCode=1;}

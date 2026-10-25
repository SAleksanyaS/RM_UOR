import path from 'node:path';
import {provisionLocalCurators} from '../src/features/identity/curator-provisioning';
import {loadSite} from '../src/server/workspace/context';
import {resolveWorkspace} from '../src/server/workspace/paths';
if(process.stdin.isTTY){console.error('Для одного профиля используйте npm run setup:curators. Пакетная команда читает JSON из стандартного ввода; не передавайте пароли аргументами командной строки.');process.exit(1);}
let input='';for await(const chunk of process.stdin){input+=chunk.toString();if(Buffer.byteLength(input)>100000)throw new Error('Слишком большой список профилей');}
try{const root=path.resolve(process.cwd()),site=await loadSite(root),workspace=await resolveWorkspace({projectRoot:root,allowedRoots:site.allowedWorkspaceRoots});const result=await provisionLocalCurators(workspace.runtimeRoot,JSON.parse(input));console.log(JSON.stringify(result));}
catch{console.error('Не удалось сохранить профили. Проверьте разрешённую папку, JSON, имена, уникальные пароли от6 символов и доступ к локальному реестру. Пароли не выведены.');process.exitCode=1;}

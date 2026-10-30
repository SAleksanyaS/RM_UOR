import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixtureId, makeNumericFixture } from './factories';
import { buildPackageManifest, canonicalBytes } from '../../../src/features/publishing/workbench/package-manifest';

const execute=promisify(execFile);
export const stagingCleanups:Array<()=>Promise<void>>=[];
export async function gitStagingFixture() {
  const root=await mkdtemp(path.join(tmpdir(),'uor-t23-юникод '));
  const previous=new Map(['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_TRACE2_EVENT'].map(key=>[key,process.env[key]]));
  const isolatedConfig=path.join(root,'synthetic-global.gitconfig');await writeFile(isolatedConfig,'');
  process.env.GIT_CONFIG_GLOBAL=isolatedConfig.replaceAll('\\','/');process.env.GIT_CONFIG_NOSYSTEM='1';
  const trace=path.join(root,'git-trace.jsonl');process.env.GIT_TRACE2_EVENT=trace.replaceAll('\\','/');
  stagingCleanups.push(async()=>{
    for(const [key,value] of previous) if(value===undefined) delete process.env[key];else process.env[key]=value;
    const resolved=path.resolve(root),allowed=path.resolve(tmpdir());if(!resolved.startsWith(allowed+path.sep)||!path.basename(resolved).startsWith('uor-t23-')) throw Error('Unsafe synthetic cleanup');
    await rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  const gitExecutable=(await execute('where.exe',['git'],{windowsHide:true})).stdout.trim().split(/\r?\n/)[0];
  const git=async(cwd:string,args:string[])=>String((await execute(gitExecutable,args,{cwd,shell:false,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024})).stdout).trim();
  const projectRoot=path.join(root,'running project'),runtimeRoot=path.join(root,'private runtime'),remoteUrl=path.join(root,'remote.git');
  await mkdir(projectRoot);await git(root,['init','--bare','--initial-branch=main',remoteUrl]);await git(projectRoot,['init','--initial-branch=main']);
  await git(projectRoot,['config','user.name','Synthetic Curator']);await git(projectRoot,['config','user.email','synthetic@example.invalid']);
  await writeFile(path.join(projectRoot,'README.md'),'Synthetic running code');await git(projectRoot,['add','--','README.md']);await git(projectRoot,['commit','-m','synthetic main']);
  await git(projectRoot,['remote','add','origin',remoteUrl]);await git(projectRoot,['push','origin','main']);
  const baseCommit=await git(projectRoot,['rev-parse','HEAD']);
  const makePackage=(seed=290001,revision=1)=>{
    const goal=makeNumericFixture().goal;const files=new Map([[`records/core_goal_definition/${goal.id}/1.json`,canonicalBytes(goal)]]);
    const manifest=buildPackageManifest({package:{schemaVersion:1,packageId:fixtureId(seed),cycleId:fixtureId(seed+1),curatorPersonId:fixtureId(seed+2),revision,baseCommit,targetBranch:'main',createdAt:'2026-10-30T06:00:00Z'},files});
    return {manifest,files,expectedRemoteHead:null};
  };
  const argv=async()=>{let lines='';try{lines=await readFile(trace,'utf8');}catch{return [];}return lines.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.event==='start').map(event=>event.argv as string[]);};
  const errors=async()=>{try{return (await readFile(trace,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.event==='error').map(event=>event.msg);}catch{return [];}};
  return {root,git,projectRoot,runtimeRoot,remoteUrl,gitExecutable,baseCommit,makePackage,argv,errors,options:{projectRoot,runtimeRoot,remoteUrl,gitExecutable,repositoryId:'synthetic-repository'}};
}

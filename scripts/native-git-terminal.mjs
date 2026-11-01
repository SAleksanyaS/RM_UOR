import { readFile,lstat,realpath } from 'node:fs/promises';
import { openSync,closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

process.exitCode=1;
async function physical(filename,executable=false) {
  if(!path.isAbsolute(filename))throw Error('invalid');const absolute=path.resolve(filename),root=path.parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(path.sep)){current=path.join(current,part);const stat=await lstat(current);if(stat.isSymbolicLink()||!executable&&stat.isFile()&&stat.nlink!==1)throw Error('invalid');}
  if((await realpath(absolute)).toLowerCase()!==absolute.toLowerCase())throw Error('invalid');
}
async function ticket(filename) {
  await physical(filename);const bytes=await readFile(filename);if(bytes.length>32768)throw Error('invalid');const value=JSON.parse(bytes.toString('utf8'));
  if(value.schemaVersion!==1||!['push','auth'].includes(value.mode)||!/^\w{64}$/.test(value.nonce)||typeof value.pipeName!=='string')throw Error('invalid');
  await physical(value.cwd);await physical(value.gitExecutable,true);
  if(value.mode==='push'&&!(value.args.length===3&&value.args[0]==='push'&&value.args[1]==='origin'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64}):refs\/heads\/uor\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(value.args[2])))throw Error('invalid');
  if(value.mode==='auth'&&JSON.stringify(value.args)!==JSON.stringify(['ls-remote','--heads','origin']))throw Error('invalid');return value;
}
function channel(value,type) {
    const socket=connect(value.pipeName),listeners=[],frames=[];let buffer='',failure=null;
    const fail=()=>{failure=Error('Native control unavailable');while(listeners.length)listeners.shift().reject(failure);};socket.on('error',fail);socket.on('close',fail);
    socket.on('connect',()=>socket.write(JSON.stringify({type,nonce:value.nonce})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>4096){socket.destroy();fail();return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let frame;try{frame=JSON.parse(line);if(!frame||typeof frame!=='object')throw Error('invalid');}catch{socket.destroy();fail();return;}if(listeners.length)listeners.shift().resolve(frame);else frames.push(frame);}});
    return {socket,next:()=>frames.length?Promise.resolve(frames.shift()):failure?Promise.reject(failure):new Promise((resolve,reject)=>listeners.push({resolve,reject}))};
}
async function main() {
  const gate=process.argv[2]==='--gate';const filename=gate?process.env.UOR_NATIVE_MANIFEST:process.argv[2]==='--manifest'?process.argv[3]:null;if(!filename)throw Error('invalid');
  const value=await ticket(filename),connection=await channel(value,gate?'gate':'session');
  const timer=setTimeout(()=>connection.socket.destroy(),120000);
  let response;try{response=await connection.next();}finally{clearTimeout(timer);}
  if(gate){connection.socket.end();process.exitCode=response.allow===true?0:1;return;}
  if(response.ok!==true)throw Error('invalid');let cancelled=false,closed=false;
  // Global names keep Node 22 from normalizing the device as a UNC share root.
  // Open existing console devices; never route secrets through application pipes.
  const consoleHandles=[];let child;
  try {
    if(process.platform==='win32'){
      consoleHandles.push(openSync('\\\\.\\Global\\CONIN$','r+'));consoleHandles.push(openSync('\\\\.\\Global\\CONOUT$','r+'));
      if(consoleHandles.some(handle=>!isatty(handle)))throw Error('Console unavailable');
    }
    child=spawn(value.gitExecutable,value.args,{cwd:value.cwd,shell:false,windowsHide:false,stdio:process.platform==='win32'?[consoleHandles[0],consoleHandles[1],consoleHandles[1]]:'inherit',env:process.env});
  } catch(error){connection.socket.destroy();throw error;}
  finally {for(const handle of consoleHandles)closeSync(handle);}
  const abort=()=>{if(closed)return;cancelled=true;if(process.platform==='win32'&&child.pid){const killer=spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill();};
  connection.socket.on('close',abort);void(async()=>{try{while(!closed){const frame=await connection.next();if(frame.type==='cancel')abort();}}catch{abort();}})();
  const exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('exit',code=>resolve(code));});closed=true;
  connection.socket.end(JSON.stringify({type:'finished',nonce:value.nonce,exitCode,cancelled})+'\n');process.exitCode=exitCode??1;
}
main().catch(()=>{process.stderr.write('Native Git session did not complete.\n');process.exitCode=1;});

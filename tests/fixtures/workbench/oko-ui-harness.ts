import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium, type BrowserContext } from 'playwright';
import { createOkoApplication } from '../../../src/server/workbench/oko-application';
export async function createOkoUiHarness() {
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'uor-oko-ui-e2e-'));
  const { build } = await import('vite');await build({configFile:path.resolve('vite.config.ts'),logLevel:'error',build:{outDir:path.join(root,'dist'),emptyOutDir:true,rollupOptions:{input:path.resolve('oko.html')}}});await mkdir(path.join(root,'config'));
  const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
  await writeFile(path.join(root,'config/oko.local.json'),JSON.stringify({port,clientPort:port===5175?5176:5175,autoOpen:false,roleMode:'local-preview'}));
  const report=createServer((req,res)=>{if(req.url?.startsWith('/export')){res.writeHead(200,{'content-type':'text/csv','content-disposition':'attachment; filename=report.csv'}).end('ID;Product;Value\nr1;p1;123456789012345.67');return;}res.setHeader('content-type','text/html');res.end('<div data-authentication><input type="password"><button id="login">Login</button></div><main style="margin-top:100px"><h1 id="ready" hidden>Report</h1><label for="period">Period</label><input id="period"><a id="export" href="/export">Export</a></main><script>function login(){document.querySelector("[data-authentication]")?.remove();document.querySelector("#ready").hidden=false;localStorage.setItem("authenticated","yes")}document.querySelector("#login").onclick=login;if(localStorage.getItem("authenticated"))login()</script>');});await new Promise<void>(r=>report.listen(0,'127.0.0.1',r));
  const reportUrl=`http://127.0.0.1:${(report.address() as {port:number}).port}/report`;
  const managed:BrowserContext[]=[];
  const instance=await createOkoApplication({projectRoot:root,browserLauncher:{launchPersistent:async(_profile,folder,options)=>{const context=await chromium.launchPersistentContext(folder,{...options,channel:'msedge',headless:true});managed.push(context);return context;}}});
  await instance.app.listen({host:'127.0.0.1',port});
  const ui=await chromium.launch({channel:'msedge',headless:true});const page=await ui.newPage({acceptDownloads:true});page.setDefaultTimeout(12000);
  const nextManaged=async(index:number)=>{const deadline=Date.now()+12000;while(!managed[index]){if(Date.now()>deadline)throw Error('Managed browser did not launch');await new Promise(r=>setTimeout(r,30));}const p=managed[index].pages()[0];await p.waitForURL(reportUrl);return p;};
  return{root,page,reportUrl,nextManaged,url:`http://127.0.0.1:${port}/oko.html`,readDownload:async(download:import('playwright').Download)=>{const file=await download.path();if(!file)throw Error('No download');return readFile(file,'utf8');},close:async()=>{await ui.close();await instance.close();await Promise.all(managed.map(c=>c.close().catch(()=>{})));await new Promise<void>(r=>report.close(()=>r()));const target=path.resolve(root);if(!target.startsWith(path.resolve(await realpath(tmpdir()))+path.sep)||!path.basename(target).startsWith('uor-oko-ui-e2e-'))throw Error('Unsafe cleanup');await rm(target,{recursive:true,force:true});}};
}

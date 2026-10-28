// Documentation checks only. Does not install, execute product code or access the network.
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {resolve, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const planRoot=dirname(fileURLToPath(import.meta.url));
const specRoot=resolve(planRoot,'../../specs/2026-10-28-uor-workbench');
const main=resolve(planRoot,'../2026-10-28-uor-workbench-rebuild.md');
const problems=[];
const hash=data=>createHash('sha256').update(data).digest('hex');
const manifest=readFileSync(resolve(specRoot,'MANIFEST.sha256'),'utf8').trim().split(/\r?\n/);
for(const line of manifest){
  const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
  if(!match){problems.push('Bad manifest line');continue;}
  const target=resolve(specRoot,match[2]),rel=relative(specRoot,target);
  if(rel.startsWith('..')||!existsSync(target)||!statSync(target).isFile())problems.push('Missing/unsafe manifest target: '+match[2]);
  else if(hash(readFileSync(target))!==match[1])problems.push('Checksum mismatch: '+match[2]);
}
const planFiles=readdirSync(planRoot).filter(n=>/^0[1-6]-.*\.md$/.test(n));
const tasks=new Map();
for(const name of planFiles){
  const source=readFileSync(resolve(planRoot,name),'utf8');
  const headings=[...source.matchAll(/^### T(\d+)[.:]\s*(.+)$/gm)];
  headings.forEach((m,i)=>{
    const id=Number(m[1]),block=source.slice(m.index,headings[i+1]?.index??source.length);
    if(tasks.has(id))problems.push('Duplicate task T'+id);
    tasks.set(id,{name,title:m[2]});
    for(const [label,ok] of [
      ['checkbox steps',block.includes('- [ ]')],
      ['assertions',block.includes('expect(')],
      ['files',/\*\*Files:/.test(block)],
      ['verification',block.includes('npm test')||block.includes('probe:readiness')],
      ['commit',block.includes('git commit')],
    ])if(!ok)problems.push(`T${id} lacks ${label}`);
  });
}
for(let id=1;id<=48;id++)if(!tasks.has(id))problems.push('Missing task T'+id);
if(tasks.size!==48)problems.push('Unexpected task count '+tasks.size);

const coverage=readFileSync(resolve(planRoot,'AC-COVERAGE.md'),'utf8');
const acceptance=readFileSync(resolve(specRoot,'19-acceptance-delivery-contract.md'),'utf8');
const acIds=[...acceptance.matchAll(/^\| (AC-\d+) \|/gm)].map(m=>m[1]);
for(const id of acIds)if(!coverage.includes('| '+id+' |'))problems.push('Unmapped acceptance '+id);
for(let id=1;id<=8;id++)if(!coverage.includes(`| OC-0${id} |`))problems.push('Missing browser acceptance OC-'+id);

const markdown=[main,...readdirSync(planRoot).filter(n=>n.endsWith('.md')).map(n=>resolve(planRoot,n)),...readdirSync(specRoot).filter(n=>n.endsWith('.md')).map(n=>resolve(specRoot,n))];
let examples=0;
for(const file of markdown){
  const source=readFileSync(file,'utf8');
  for(const m of source.matchAll(/(?:```|~~~)json\s*\n([\s\S]*?)(?:```|~~~)/g)){
    try{JSON.parse(m[1]);examples++;}catch{problems.push('Invalid JSON example: '+relative(planRoot,file));}
  }
  const prose=source.replace(/^(?<fence>```|~~~)[^\n]*\n[\s\S]*?^\k<fence>\s*$/gm,'');
  for(const m of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
    const target=m[1].replace(/^<|>$/g,'').split('#')[0];
    if(!target||/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('/'))continue;
    if(!existsSync(resolve(dirname(file),target)))problems.push('Broken link in '+relative(planRoot,file)+': '+target);
  }
}
if(problems.length){for(const p of problems)console.error(p);process.exitCode=1;}
else{
  console.log(`PASS: ${manifest.length} approved document checksums; ${tasks.size} tasks; ${acIds.length} AC + 8 OC; ${examples} JSON examples; local links.`);
  console.log('Documentation validation only. This command does not run product tests, build or bank probes.');
}

import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const {satisfies}=createRequire(import.meta.url)('semver') as {satisfies:(version:string,range:string)=>boolean};
const baseline={node:'22.16.0',npm:'10.9.2'};
type Package={version?:string;engines?:Partial<Record<keyof typeof baseline,string>>};
const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as Package;
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8')) as {packages:Record<string,Package>};

describe('corporate Node.js 22.16.0 / npm 10.9.2 baseline',()=>{
  it('allows the baseline in the application requirements',()=>{
    expect(satisfies(baseline.node,manifest.engines?.node??'*')).toBe(true);
    expect(satisfies(baseline.npm,manifest.engines?.npm??'*')).toBe(true);
  });
  it('supports every locked package, including optional Linux and macOS packages',()=>{
    const incompatible=Object.entries(lock.packages).flatMap(([path,pkg])=>
      (Object.keys(baseline) as (keyof typeof baseline)[]).flatMap(runtime=>{
        const required=pkg.engines?.[runtime];
        return required&&!satisfies(baseline[runtime],required)?[`${path||'application'}@${pkg.version}: ${runtime} ${required}`]:[];
      }));
    expect(incompatible,'A dependency update raised the corporate runtime requirement').toEqual([]);
  });
});

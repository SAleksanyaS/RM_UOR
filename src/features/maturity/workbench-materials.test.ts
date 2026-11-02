import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadMaturityMaterials, makeMaturityDefinitions, createMaturitySnapshot } from './workbench-materials';
import { evaluateMaturity } from './workbench-evaluate';

describe('real source maturity matrix',()=>{
 it('preserves exact selected originals and source classifications',()=>{
  const b=loadMaturityMaterials();
  for(const s of b.sources) expect(createHash('sha256').update(readFileSync(s.path)).digest('hex')).toBe(s.sha256);
  expect(b.teams).toHaveLength(58);expect(new Set(b.teams.map(t=>t.code)).size).toBe(58);
  expect(b.metrics).toHaveLength(5);expect(b.organizations.filter(o=>o.kind==='block')).toHaveLength(1);expect(b.organizations.filter(o=>o.kind==='tribe')).toHaveLength(3);expect(b.organizations.filter(o=>o.kind==='cluster')).toHaveLength(24);
  expect(b.observations).toHaveLength(290);expect(b.rollups).toHaveLength(434);
  expect(b.leaders.map(l=>l.teamIds.length)).toEqual([7,8,10,9,6,9,4,5]);
  expect(b.observations.find(o=>o.source.kind==='xlsx'&&o.source.cell==='N311')).toMatchObject({state:'missing',raw:'Нет данных',teamId:b.teams.find(t=>t.code==='00HH0060')!.id});
  expect(b.observations.find(o=>o.source.kind==='xlsx'&&o.source.cell==='N308')).toMatchObject({state:'no_event'});
 });
 it('keeps fixed expected matrix and all unresolved states without granting success',()=>{
  const b=loadMaturityMaterials(), d=makeMaturityDefinitions(b);
  const e=evaluateMaturity({definition:d,observations:b.observations,reportedClaims:b.reportedClaims});
  expect(e.counts).toMatchObject({expected:290,numeric:273,met:271,notMet:2,exception:15,noEvent:1,missing:1});
  expect(e.complete).toBe(false);expect(e.canConfirm).toBe(false);expect(e.reportedClaims[0]).toMatchObject({authority:'source_reported'});
  const removed=evaluateMaturity({definition:d,observations:b.observations.filter(o=>o.teamId!==b.teams[0].id),reportedClaims:[]});
  expect(removed.counts.expected).toBe(290);expect(removed.counts.missing).toBe(6);
  const metricRemoved=evaluateMaturity({definition:d,observations:b.observations.filter(o=>o.metricId!==b.metrics[0].id),reportedClaims:[]});
  expect(metricRemoved.counts.expected).toBe(290);expect(metricRemoved.counts.missing).toBeGreaterThanOrEqual(58);
 });
 it('freezes names and reported history separately from independently evaluated facts',()=>{
  const b=loadMaturityMaterials(),s=createMaturitySnapshot(b,'2026-10-30'); const old=s.teams[0].name;
  b.teams[0].name='Changed';expect(s.teams[0].name).toBe(old);
  expect(s.reportedClaims.find(c=>c.period==='2026-10-25')).toMatchObject({teamsMet:54,metricsMet:270,metricsAvailable:274});
  expect(s).not.toHaveProperty('attestation');expect(s.comparableHistory).toBe(false);
 });
});

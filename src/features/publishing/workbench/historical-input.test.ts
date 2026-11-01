import { expect, it } from 'vitest';
import type { EvaluationBasis } from '../../../domain/workbench/entities';
import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import { makeEntityGraph, makeHeader, makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { evaluateAssignment } from '../../evaluation/workbench/evaluate';
import { buildHistoricalEvaluationInput } from './historical-input';

function fixture() {
  const input=makeNumericFixture(), graph=makeEntityGraph(input), content=canonicalBasis(input);
  const basis:EvaluationBasis={...makeHeader(16),...content,evaluatedAt:input.context.evaluatedAt,digest:digestBasis(content)};
  const reads:Array<EntityRef|VersionRef>=[];
  const read=(ref:EntityRef|VersionRef)=>{
    reads.push(ref);
    if(ref.entityType==='publication_anchor') return graph.anchors.find(anchor=>anchor.id===ref.id)??null;
    if(!('revision' in ref)) throw Error('Historical input must never read current heads');
    return graph.entries.find(entry=>entry.entityType===ref.entityType&&entry.value.id===ref.id&&entry.value.revision===ref.revision)?.value??null;
  };
  return {input,basis,reads,read};
}
it('replays saved exact versions, immutable capture revision one, evaluatedAt and actor without current heads',()=>{
  const f=fixture(), before=structuredClone(f.basis), actual=buildHistoricalEvaluationInput(f.basis,f.read);
  expect(actual.context).toEqual(f.input.context);expect(actual.resolution.actor).toEqual(f.basis.actor);
  expect(f.reads.filter(ref=>ref.entityType==='capture')).toEqual([{entityType:'capture',id:f.input.captures[0].id,revision:1}]);
  expect(digestBasis(canonicalBasis(actual))).toBe(f.basis.digest);expect(evaluateAssignment(actual)).toEqual(evaluateAssignment(f.input));expect(f.basis).toEqual(before);
});
it('rejects missing saved evaluation time explicitly before reading or guessing any inputs',()=>{
  const f=fixture();expect(()=>buildHistoricalEvaluationInput({...f.basis,evaluatedAt:null},f.read)).toThrowError(expect.objectContaining({code:'BASIS_EVALUATION_TIME_UNKNOWN'}));expect(f.reads).toEqual([]);
});
it('rejects an exact reference reader returning the current revision instead',()=>{
  const f=fixture();expect(()=>buildHistoricalEvaluationInput(f.basis,ref=>{const value=f.read(ref);return value&&ref.entityType==='goal_assignment'?{...value,revision:2}:value;})).toThrowError(expect.objectContaining({code:'REFERENCE_VERSION_MISMATCH'}));
});

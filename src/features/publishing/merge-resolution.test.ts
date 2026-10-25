import { expect, it } from 'vitest';
import { inspectMerge } from './merge-object';
it('resolves only selected overlapping fields and preserves both independent edits',()=>{
 const base={title:'old',weight:1,owner:'a'},local={...base,title:'mine',weight:2},remote={...base,title:'theirs',owner:'b'};
 const preview=inspectMerge(base,local,remote);expect(preview.conflicts.map(c=>c.path)).toEqual(['/title']);
 const result=inspectMerge(base,local,remote,{'/title':'remote'});expect(result.conflicts).toEqual([]);expect(result.value).toEqual({title:'theirs',weight:2,owner:'b'});
});
it('uses unambiguous paths for dotted and escaped mapping keys and handles deletion',()=>{
 const b={'a.b':1,'a/b':2},l={'a.b':3,'a/b':4},r={'a.b':5,'a/b':6};
 expect(inspectMerge(b,l,r).conflicts.map(c=>c.path)).toEqual(['/a.b','/a~1b']);
 expect(inspectMerge({x:1},{},{x:2},{'/x':'local'}).value).toEqual({});
});

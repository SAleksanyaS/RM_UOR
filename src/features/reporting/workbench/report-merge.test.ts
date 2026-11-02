import {it,expect} from 'vitest';
import {defaultReportDefinition} from './contracts';
import {mergeReportDefinitions} from './report-merge';
it('merges independent fields and requires explicit section title resolution',()=>{
 const base=defaultReportDefinition('2026-10-30'),mine=structuredClone(base),latest=structuredClone(base);mine.comment='B comment';latest.title='A title';expect(mergeReportDefinitions(base,mine,latest)).toMatchObject({merged:{title:'A title',comment:'B comment'},unresolved:[]});
 mine.sections[0].title='B section';latest.sections[0].title='A section';expect(mergeReportDefinitions(base,mine,latest).unresolved).toHaveLength(1);expect(mergeReportDefinitions(base,mine,latest,{'sections.summary.title':'latest'})).toMatchObject({merged:{sections:[{title:'A section'},{},{},{}]},unresolved:[]});
});

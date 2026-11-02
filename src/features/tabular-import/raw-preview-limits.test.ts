import { expect, it } from 'vitest';
import { parseWorkbenchTable } from './workbench-parser';
import { defaultSourceParsingProfile } from '../../domain/workbench/schemas/sources';

it('allows a bounded 100000-row raw preview while keeping the ordinary import limit at 20000', async () => {
  const bytes=Buffer.from('Row,Team,Value,Date,Status\n'+Array.from({length:100000},(_,i)=>`${i},T${i%58},${i%101},2026-10-30,ready`).join('\n'));
  const input={bytes,name:'large.csv',parsingProfile:defaultSourceParsingProfile};
  await expect(parseWorkbenchTable(input)).rejects.toMatchObject({code:'TABLE_LIMIT_EXCEEDED'});
  const raw=await parseWorkbenchTable({...input,purpose:'raw-preview'});
  expect(raw.rows).toHaveLength(100000);
  expect(raw.rows.at(-1)!.cells.Row.original).toBe('99999');
  await expect(parseWorkbenchTable({...input,bytes:Buffer.concat([bytes,Buffer.from('\n100000,T1,0,2026-10-30,ready')]),purpose:'raw-preview'})).rejects.toMatchObject({code:'TABLE_LIMIT_EXCEEDED'});
});
it('rejects a raw table wider than the cell budget before building its dense projection', async () => {
  const header=Array.from({length:100},(_,i)=>'C'+i).join(','),row=Array(100).fill('x').join(',');
  const bytes=Buffer.from(header+'\n'+Array(10001).fill(row).join('\n'));
  const outcome=await parseWorkbenchTable({bytes,name:'wide.csv',parsingProfile:defaultSourceParsingProfile,purpose:'raw-preview'}).then(()=> 'accepted',error=>error.code);
  expect(outcome).toBe('TABLE_LIMIT_EXCEEDED');
});

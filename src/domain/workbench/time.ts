import { moscowDateSchema } from './primitives';
import type { MoscowDate, UtcInstant } from './primitives';
import { WorkbenchError } from './errors';

export { newUuid } from './primitives';

const dayMs = 86_400_000;
const moscowOffsetMs = 3 * 60 * 60 * 1000;

export function moscowStart(date: MoscowDate): UtcInstant {
  moscowDateSchema.parse(date);
  return new Date(Date.parse(date + 'T00:00:00.000Z') - moscowOffsetMs).toISOString();
}

export function moscowEnd(date: MoscowDate): UtcInstant {
  return new Date(Date.parse(moscowStart(date)) + dayMs - 1).toISOString();
}

export function addMoscowDays(date: MoscowDate, days: number): MoscowDate {
  moscowDateSchema.parse(date);
  if (!Number.isSafeInteger(days)) throw new WorkbenchError('INVALID_DAY_OFFSET');
  const changed = new Date(Date.parse(date + 'T00:00:00.000Z') + days * dayMs);
  if (!Number.isFinite(changed.getTime())) throw new WorkbenchError('DATE_OUT_OF_RANGE');
  const result = changed.toISOString().slice(0, 10);
  return moscowDateSchema.parse(result);
}

import { createHash } from 'node:crypto';
import { WorkbenchError } from '../../domain/workbench/errors';
/** A cursor is bound to the entire immutable filter, including clock and page size. */
export function historyFingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function encodeHistoryCursor(filter: string, position: unknown): string { return Buffer.from(JSON.stringify({ filter, position })).toString('base64url'); }
export function decodeHistoryCursor(cursor: string, filter: string): unknown {
    try {
        const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            filter: string;
            position: unknown;
        };
        if (v.filter !== filter)
            throw new Error();
        return v.position;
    }
    catch {
        throw new WorkbenchError('INVALID_CURSOR');
    }
}

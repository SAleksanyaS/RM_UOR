import { createHash } from 'node:crypto';
import type { ProductionArchiveOwner } from '../../workspace-maintenance/workbench/production-archive-contracts';
import type { WorkspaceArchiveRecord } from '../../workspace-maintenance/workbench/contracts';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { reportSnapshotSchema } from './contracts';
import { reportDigest } from './service';
import { createReportStore } from './store';
const invalid = (): never => { throw new WorkbenchHttpError(422, 'INVALID_ARCHIVE', 'Invalid report snapshot'); };
export function createReportArchiveOwner(): ProductionArchiveOwner {
    const parse = (record: WorkspaceArchiveRecord) => { if (record.moduleId !== 'reporting' || record.schemaId !== 'report.snapshot' || record.schemaVersion !== 1)
        invalid(); const s = reportSnapshotSchema.parse(record.value); if (record.key !== s.id + '/' + s.revision)
        invalid(); const { digest, ...base } = s; if (reportDigest(base) !== digest || createHash('sha256').update(Buffer.from(s.template.bytesBase64, 'base64')).digest('hex') !== s.template.sha256)
        invalid(); if (s.template.id !== s.definition.template || (s.definition.template === 'goal-management-v1' ? s.goalData === null || s.maturity !== null : s.maturity === null || s.goalData !== null))
        invalid(); return s; };
    const authorize: ProductionArchiveOwner['authorize'] = (records, person, installation) => { for (const record of records) {
        const s = parse(record);
        if (!person || s.ownerPersonId !== person)
            throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Report belongs to another person');
    } if (!installation)
        invalid(); };
    return { moduleId: 'reporting', isUserData: () => true, exportRecords(repository) { return createReportStore(repository).all().map(s => ({ moduleId: 'reporting', schemaId: 'report.snapshot', schemaVersion: 1, key: s.id + '/' + s.revision, value: s })); }, validate(record) { parse(record); }, authorize, fileReferences: () => [], async files() { return []; }, validateArchive(archive) { const seen = new Set<string>(); for (const record of archive.records.filter(r => r.moduleId === 'reporting')) {
            parse(record);
            if (seen.has(record.key))
                invalid();
            seen.add(record.key);
        } }, restoreRecords(repository, records, context) { if (!context)
            invalid(); authorize(records, context!.personId, context!.installationId); const store = createReportStore(repository); for (const record of records) {
            const s = parse(record);
            const existing = store.read(s.id, s.revision);
            if (existing) {
                if (existing.digest !== s.digest)
                    invalid();
            }
            else
                store.insert(s, context!.installationId);
        } } };
}

import type { Header } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';

/** Publishing never infers permission from an immutable, caller-visible actor label. */
export function isTrustedOwnPublicationVersion(repository: WorkbenchRepository, entityType: string, value: Header, owner: { installationId: string; personId: string | null }): boolean {
  try {
    const binding = repository.sqlForModule('ownership').get<{ installation_id: string; person_id: string | null }>(
      'SELECT installation_id,person_id FROM wb_ownership_bindings WHERE module_id=? AND object_key=?',
      ['core', `${entityType}/${value.id}/${value.revision}`]);
    return binding !== null && binding.installation_id === owner.installationId && binding.person_id === owner.personId;
  } catch (error) {
    if (error instanceof Error && /no such table: wb_ownership_bindings/.test(error.message)) return false;
    throw error;
  }
}

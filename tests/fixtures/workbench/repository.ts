import type { WorkbenchRepository } from '../../../src/server/storage/workbench-repository';
import type { makeEntityGraph } from './factories';

export function seedGraph(repository: WorkbenchRepository, graph: ReturnType<typeof makeEntityGraph>): void {
  repository.transaction(() => {
    for (const anchor of graph.anchors) repository.appendPublicationAnchor(anchor, null);
    for (const { entityType, value } of graph.entries) repository.append(entityType, value, null);
  });
}

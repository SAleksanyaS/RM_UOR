import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attestation, CatalogSnapshot, DomainChangeEvent, LocalSnapshot } from '../../domain/contracts';
import { validateAttestation, validateCatalog, validateChangeEvent, validateSnapshot } from '../publishing/validate-version';
import { normalizeDirections } from './directions';

async function filesBelow(root: string, relative: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await filesBelow(root, file));
    else if (entry.isFile() && entry.name.endsWith('.json')) result[file] = await readFile(path.join(root, file), 'utf8');
  }
  return result;
}
/** Apply already cloned shared content without requiring a network connection. */
export async function readLocalRelease(root: string, base: CatalogSnapshot) {
  const catalog = structuredClone(base);
  const files = { ...await filesBelow(root, 'catalog'), ...await filesBelow(root, 'published'), ...await filesBelow(root, 'changes') };
  if (Object.keys(files).some(file => /^catalog\/directions\/[^/]+\.json$/.test(file))) {
    // Materialize legacy bindings before a direction overlay makes the taxonomy
    // explicit. Leave a file-less legacy base untouched for its existing hash.
    const normalized = normalizeDirections(catalog);
    catalog.directions = normalized.directions; catalog.goals = normalized.goals;
  }
  const collections: Record<string, { id: string }[]> = { goals: catalog.goals, assignments: catalog.assignments, sources: catalog.sources, entities: catalog.entities, comments: catalog.comments, directions: catalog.directions ?? [] };
  for (const [file, content] of Object.entries(files)) {
    const match = file.match(/^catalog\/(goals|assignments|sources|entities|comments|directions)\/[^/]+\.json$/);
    if (!match) continue;
    const item = JSON.parse(content) as { id: string }; const collection = collections[match[1]];
    const index = collection.findIndex(value => value.id === item.id);
    if (index >= 0) collection[index] = item; else collection.push(item);
  }
  const snapshots: LocalSnapshot[] = []; const attestations: Attestation[] = []; const changes: DomainChangeEvent[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (/^published\/snapshots\/.+\/manifest\.json$/.test(file)) {
      const manifest = JSON.parse(content) as LocalSnapshot;
      const rows = files[file.replace(/manifest\.json$/, 'observations.json')];
      if (!rows) throw new Error(`В опубликованном снимке нет наблюдений: ${file}`);
      snapshots.push({ ...manifest, observations: JSON.parse(rows) });
    } else if (file.startsWith('published/attestations/')) attestations.push(JSON.parse(content));
    else if (file.startsWith('changes/')) changes.push(JSON.parse(content));
  }
  const validatedCatalog = validateCatalog(catalog);
  return { catalog: validatedCatalog, snapshots: snapshots.map(s => validateSnapshot(s, validatedCatalog)),
    attestations: attestations.map(a => validateAttestation(a, validatedCatalog)), changes: changes.map(validateChangeEvent) };
}

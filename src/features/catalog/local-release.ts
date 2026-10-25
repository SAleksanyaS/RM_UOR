import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attestation, CatalogSnapshot, DomainChangeEvent, LocalSnapshot } from '../../domain/contracts';
import { validateAttestation, validateCatalog, validateChangeEvent, validateSnapshot } from '../publishing/validate-version';
import { normalizeDirections } from './directions';
import { assertCompatibleRelease } from '../system/compatibility';
import { validateTemplateBundle } from '../report-templates/service';
import { validateEvidenceBundle } from '../evidence/evidence-service';

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
  assertCompatibleRelease(files);
  if (Object.keys(files).some(file => /^catalog\/directions\/[^/]+\.json$/.test(file))) {
    // Materialize legacy bindings before a direction overlay makes the taxonomy
    // explicit. Leave a file-less legacy base untouched for its existing hash.
    const normalized = normalizeDirections(catalog);
    catalog.directions = normalized.directions; catalog.goals = normalized.goals;
  }
  const collections: Record<string, { id: string }[]> = { leaders: catalog.leaders, goals: catalog.goals, assignments: catalog.assignments, sources: catalog.sources, entities: catalog.entities, comments: catalog.comments, directions: catalog.directions ?? [] };
  for (const [file, content] of Object.entries(files)) {
    const match = file.match(/^catalog\/(leaders|goals|assignments|sources|entities|comments|directions)\/[^/]+\.json$/);
    if (!match) continue;
    const item = JSON.parse(content) as { id: string }; const collection = collections[match[1]];
    const index = collection.findIndex(value => value.id === item.id);
    if (index >= 0) collection[index] = item; else collection.push(item);
  }
  const snapshots: LocalSnapshot[] = []; const attestations: Attestation[] = []; const changes: DomainChangeEvent[] = [];
  const templates:Awaited<ReturnType<typeof validateTemplateBundle>>[]=[];
  const evidence:ReturnType<typeof validateEvidenceBundle>[]=[];
  for (const [file, content] of Object.entries(files)) {
    if(/^published\/evidence\/[^/]+\.json$/.test(file)){const checked=validateEvidenceBundle(JSON.parse(content),catalog.classification);if(file!==`published/evidence/${checked.bundle.id}.json`)throw new Error('Путь доказательства не совпадает с его идентификатором');if(evidence.some(e=>e.bundle.id===checked.bundle.id))throw new Error('В выпуске повторяется доказательство');evidence.push(checked);continue;}
    if(/^published\/templates\/[^/]+\.json$/.test(file)){const checked=await validateTemplateBundle(JSON.parse(content));if(file!==`published/templates/${checked.bundle.id}.json`)throw new Error('Путь шаблона не совпадает с его идентификатором');if(checked.bundle.classification!==catalog.classification)throw new Error('Классификация шаблона не совпадает с каталогом');templates.push(checked);continue;}
    if (/^published\/snapshots\/.+\/manifest\.json$/.test(file)) {
      const manifest = JSON.parse(content) as LocalSnapshot;
      const rows = files[file.replace(/manifest\.json$/, 'observations.json')];
      if (!rows) throw new Error(`В опубликованном снимке нет наблюдений: ${file}`);
      snapshots.push({ ...manifest, observations: JSON.parse(rows) });
    } else if (file.startsWith('published/attestations/')) attestations.push(JSON.parse(content));
    else if (file.startsWith('changes/')) changes.push(JSON.parse(content));
  }
  const validatedCatalog = validateCatalog(catalog);
  const validatedAttestations=attestations.map(a => validateAttestation(a, validatedCatalog));
  for(const attestation of validatedAttestations)if(attestation.evidenceIds.some(id=>!evidence.some(e=>e.bundle.id===id)))throw new Error('В выпуске отсутствует файл доказательства подтверждённой цели');
  return { catalog: validatedCatalog, templates,evidence,snapshots: snapshots.map(s => validateSnapshot(s, validatedCatalog)),
    attestations: validatedAttestations, changes: changes.map(validateChangeEvent) };
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCommonSetupPackage } from './setup-package-builder';
/** Explicit local artifact build; no runtime database or identity is read. */
const destination = process.argv[2];
if (!destination)
    throw Error('Usage: node --import tsx src/features/workspace-maintenance/workbench/setup-package-cli.ts OUTPUT.json');
const artifact = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: true, references: true, dashboards: true, reports: true, weeklyPrompts: true, publishedRoots: [] } });
await mkdir(path.dirname(path.resolve(destination)), { recursive: true });
const bytes = JSON.stringify(artifact);
await writeFile(destination, bytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({ path: path.resolve(destination), bytes: Buffer.byteLength(bytes), sha256: artifact.sha256, inventory: artifact.inventory }) + '\n');

import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createSharedBrowserResultReader } from './workbench-browser-results';
import { makeNumericFixture } from '../../../tests/fixtures/workbench/factories';
import type { QueryContext } from '../../server/workbench/query-registry';

it('serializes immutable canonical values and historical lineage while neutralizing formulas only in the derived CSV', async () => {
  const fixture = makeNumericFixture(), capture = fixture.captures[0];
  capture.canonicalRows[0].dimensions.note = '=HYPERLINK("https://example.invalid")';
  const original = Buffer.from('original;=HYPERLINK("https://example.invalid")\r\n');
  const hash = createHash('sha256').update(original).digest('hex');
  const reader = createSharedBrowserResultReader({ sources: { readOwnCaptureArtifact: () => ({ bytes: original, view: { capture, facts: fixture.facts, issues: [], coverage: { complete: true, receivedRows: 1, expectedRows: 1, evidence: ['Synthetic unit fixture'] }, artifact: { artifactId: capture.id, bytes: original.length, hash: 'sha256:' + hash, mimeType: 'text/csv' } } }) } });
  const context = { installationId: capture.actor.installationId, ownAccess: { role: 'viewer', personId: null, policyState: 'unavailable' } } as QueryContext;
  const raw = await reader.read(context, capture.id, 'original'); expect(Buffer.from(raw.bytes)).toEqual(original); expect(raw.sha256).toBe(hash);
  const derived = await reader.read(context, capture.id, 'enriched'), text = Buffer.from(derived.bytes).toString('utf8');
  expect(text).toContain("'=HYPERLINK"); expect(text).toContain(fixture.assignment.scope.kind + ':' + fixture.assignment.scope.id); expect(text).toContain(fixture.facts[0].id);
  expect(capture.canonicalRows[0].dimensions.note).toBe('=HYPERLINK("https://example.invalid")'); expect(Buffer.from(raw.bytes)).toEqual(original);
  expect(derived.sha256).toBe(createHash('sha256').update(derived.bytes).digest('hex'));
});

it('requires the central store to return an owned completed artifact rather than guessing another capture', async () => {
  const fixture = makeNumericFixture(); const reader = createSharedBrowserResultReader({ sources: { readOwnCaptureArtifact: () => null } });
  await expect(reader.read({ installationId: fixture.goal.actor.installationId, ownAccess: { role: 'viewer', personId: null, policyState: 'unavailable' } } as QueryContext, fixture.captures[0].id, 'original')).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND', statusCode: 404 });
});

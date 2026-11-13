import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserScenario, serializeBrowserScenario } from '../src/browser-scenario.mjs';
import { renderBrowserConnectors, renderBrowserEditor } from '../public/browser-view.js';

const scenario = { format: 'rm-uor-browser-scenario', version: 1, actions: [
  { type: 'click', selector: '#open-filters' },
  { type: 'click', selector: '[data-testid="quarter-q4"]' },
  { type: 'wait', selector: 'body > main:nth-of-type(1) > div.report' }
], downloadSelector: 'button#download-xlsx' };
const invalid = { code: 'BROWSER_SCENARIO_INVALID', status: 400 };

test('portable scenario roundtrips canonical recorded selectors and order', () => {
  const { actions, downloadSelector } = scenario;
  const text = serializeBrowserScenario({ actions, downloadSelector });
  assert.deepEqual(parseBrowserScenario(Buffer.from('\ufeff' + text)), scenario);
  assert.equal(serializeBrowserScenario(scenario), text);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseBrowserScenario(serializeBrowserScenario({ actions: [], downloadSelector: '#download' })), {
    format: 'rm-uor-browser-scenario', version: 1, actions: [], downloadSelector: '#download'
  });
});

test('refuses version changes, extra state, URLs, fill values and credential selectors', () => {
  for (const change of [
    { version: 2 }, { format: 'unrelated' }, { url: 'https://reports.example.test/' },
    { allowedOrigins: ['https://reports.example.test'] }, { cookies: [] }, { executablePath: 'C:/browser' },
    { actions: [{ type: 'fill', selector: '#filter', value: 'quarter' }] },
    { actions: [{ type: 'click', selector: '#filter', value: 'ignored' }] },
    { actions: [{ type: 'click', selector: 'a[href="https://reports.example.test/action"]' }] },
    { actions: [{ type: 'click', selector: '[data-testid="api-token"]' }] },
    { actions: [{ type: 'click', selector: '#login' }] },
    { actions: [{ type: 'click', selector: '#filter >> #result' }] },
    { actions: Array(13).fill({ type: 'wait', selector: '#result' }) },
    { downloadSelector: 'button[data-url="/api/private"]' }
  ]) assert.throws(() => parseBrowserScenario(JSON.stringify({ ...scenario, ...change })), invalid);
  assert.throws(() => serializeBrowserScenario({ actions: [] }), invalid);
  assert.throws(() => serializeBrowserScenario({ actions: scenario.actions, profile: 'local' }), invalid);
  assert.throws(() => parseBrowserScenario('not json'), invalid);
  assert.throws(() => parseBrowserScenario(Buffer.from([255, 254, 13, 0])), invalid);
  assert.throws(() => parseBrowserScenario(' '.repeat(16 * 1024) + JSON.stringify(scenario)), invalid);
});

test('shows recording controls only when appropriate and exposes portable editor actions', () => {
  const helpers = { escape: value => String(value ?? ''), heading: () => '', empty: () => '' };
  const connector = { id: 'sample', name: 'Сводка', url: 'https://reports.example.test/',
    actions: [], readySelector: '#ready', reportSelector: '#report' };
  const model = { connectors: [connector], openProfiles: [connector.id], jobs: [], reports: [] };
  assert.match(renderBrowserConnectors(model, helpers), /data-action="browser-record"/u);
  const active = renderBrowserConnectors({ ...model, recordings: [{ connectorId: connector.id, active: true }] }, helpers);
  assert.match(active, /data-action="browser-record-stop"/u);
  assert.match(active, /data-action="browser-collect" data-id="sample" disabled/u);
  assert.match(active, /data-action="browser-read" data-id="sample" disabled/u);
  assert.doesNotMatch(active, /data-action="browser-scenario-apply"/u);
  const completed = renderBrowserConnectors({ ...model, recordings: [{ connectorId: connector.id, ...scenario }] }, helpers);
  assert.match(completed, /data-action="browser-scenario-apply"/u);
  const editor = renderBrowserEditor({ ...model, editing: connector }, helpers);
  assert.match(editor, /id="browser-scenario-file" name="scenarioFile" type="file"/u);
  assert.match(editor, /data-action="browser-scenario-export"/u);
});

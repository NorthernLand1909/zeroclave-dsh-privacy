import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { EVENT_VALUES } from '../src/contracts.ts';

test('public event contract is limited to the three approved events', () => {
  assert.deepEqual(EVENT_VALUES, {
    privacy_active: null,
    protected_send: null,
    detector_used: ['regex', 'embedded', 'zeroclave'],
  });
});

test('Wrangler disables public alternates and persistent logging', async () => {
  const configuration = JSON.parse(
    await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  ) as {
    dependencies_instrumentation?: { enabled?: boolean };
    observability?: { enabled?: boolean; logs?: { invocation_logs?: boolean } };
    preview_urls?: boolean;
    send_metrics?: boolean;
    triggers?: { crons?: string[] };
    workers_dev?: boolean;
  };

  assert.equal(configuration.workers_dev, false);
  assert.equal(configuration.preview_urls, false);
  assert.equal(configuration.send_metrics, false);
  assert.equal(configuration.dependencies_instrumentation?.enabled, false);
  assert.equal(configuration.observability?.enabled, false);
  assert.equal(configuration.observability?.logs?.invocation_logs, false);
  assert.deepEqual(configuration.triggers?.crons, ['15 * * * *']);
});

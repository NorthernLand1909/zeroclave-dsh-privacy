import assert from 'node:assert/strict';
import test from 'node:test';

import { EVENT_VALUES, PRODUCT } from '../src/contracts.ts';
import {
  PayloadValidationError,
  parseTelemetryPayload,
} from '../src/schema.ts';

const DAILY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

test('accepts every declared event/value combination', () => {
  for (const [event, values] of Object.entries(EVENT_VALUES)) {
    if (values === null) {
      const parsed = parseTelemetryPayload(basePayload(event));
      assert.equal(parsed.event, event);
      assert.equal(parsed.value, undefined);
      continue;
    }

    for (const value of values) {
      const parsed = parseTelemetryPayload({ ...basePayload(event), value });
      assert.equal(parsed.event, event);
      assert.equal(parsed.value, value);
    }
  }
});

test('rejects unknown fields, events, and values', () => {
  assertInvalid({ ...basePayload('privacy_active'), extra: true });
  assertInvalid(basePayload('invented_event'));
  assertInvalid({ ...basePayload('detector_used'), value: 'arbitrary' });
});

test('enforces whether an event has a value', () => {
  assertInvalid({ ...basePayload('privacy_active'), value: 'enabled' });
  assertInvalid(basePayload('detector_used'));
});

test('requires a canonical 16-byte daily id and bounded semver', () => {
  assertInvalid({ ...basePayload('privacy_active'), daily_id: 'not-random' });
  assertInvalid({
    ...basePayload('privacy_active'),
    daily_id: '______________________',
  });
  assertInvalid({ ...basePayload('privacy_active'), plugin_version: 'latest' });
  assertInvalid({
    ...basePayload('privacy_active'),
    plugin_version: `1.0.0-${'a'.repeat(65)}`,
  });

  assert.equal(
    parseTelemetryPayload({
      ...basePayload('privacy_active'),
      plugin_version: '0.1.0-alpha.11+build.2',
    }).plugin_version,
    '0.1.0-alpha.11+build.2',
  );
});

test('requires the fixed product and schema version', () => {
  assertInvalid({ ...basePayload('privacy_active'), product: 'other' });
  assertInvalid({ ...basePayload('privacy_active'), schema_version: 2 });
});

function basePayload(event: string): Record<string, unknown> {
  return {
    schema_version: 1,
    product: PRODUCT,
    event,
    daily_id: DAILY_ID,
    plugin_version: '0.1.0-alpha.11',
  };
}

function assertInvalid(value: unknown): void {
  assert.throws(() => parseTelemetryPayload(value), PayloadValidationError);
}

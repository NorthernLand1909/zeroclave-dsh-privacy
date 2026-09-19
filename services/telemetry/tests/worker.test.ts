import assert from 'node:assert/strict';
import test from 'node:test';

import { PRODUCT, type SummaryRow, type TelemetryRecord } from '../src/contracts.ts';
import { canonicalRequest, hmacHex, sha256Hex } from '../src/crypto.ts';
import { createWorker } from '../src/index.ts';
import type { TelemetryStore } from '../src/store.ts';

const NOW = new Date('2026-09-18T10:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const CURRENT_SECRET = 'current-secret-0123456789abcdef0123456789';
const PREVIOUS_SECRET = 'previous-secret-0123456789abcdef0123456';
const DAILY_SECRET = 'daily-secret-0123456789abcdef01234567890';
const DAILY_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

class MemoryStore implements TelemetryStore {
  readonly nonces = new Set<string>();
  readonly records = new Map<string, TelemetryRecord>();
  summary: SummaryRow[] = [];
  maintenanceAt: Date | undefined;

  async claimNonce(
    keyId: string,
    nonceHash: string,
    _createdAt: number,
    _expiresAt: number,
  ): Promise<boolean> {
    const key = `${keyId}:${nonceHash}`;
    if (this.nonces.has(key)) return false;
    this.nonces.add(key);
    return true;
  }

  async recordEvent(record: TelemetryRecord): Promise<void> {
    this.records.set(
      `${record.day}:${record.event}:${record.value}:${record.dailyIdHash}`,
      record,
    );
  }

  async getSummary(_fromDay: string, _toDay: string): Promise<SummaryRow[]> {
    return this.summary;
  }

  async runMaintenance(now: Date): Promise<void> {
    this.maintenanceAt = now;
  }
}

test('accepts a signed event and stores only the day-scoped daily-id HMAC', async () => {
  const { worker, store } = harness();
  const response = await worker.fetch(
    await signedRequest(validPayload(), {
      nonce: 'abcdefghijklmnopQRSTUV',
    }),
    environment(),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
  const [record] = [...store.records.values()];
  assert.ok(record);
  assert.equal(record.day, '2026-09-18');
  assert.equal(record.event, 'privacy_active');
  assert.equal(record.value, '');
  assert.equal(record.pluginVersion, '0.1.0-alpha.11');
  assert.match(record.dailyIdHash, /^[0-9a-f]{64}$/);
  assert.equal(record.dailyIdHash.includes(DAILY_ID), false);
});

test('daily-id hashes differ across UTC days', async () => {
  const first = harness(NOW);
  const second = harness(new Date('2026-09-19T10:00:00.000Z'));
  const firstTimestamp = String(Math.floor(NOW.getTime() / 1000));
  const secondTimestamp = String(
    Math.floor(new Date('2026-09-19T10:00:00.000Z').getTime() / 1000),
  );

  await first.worker.fetch(
    await signedRequest(validPayload(), {
      nonce: 'nonce-for-first-day-01',
      timestamp: firstTimestamp,
    }),
    environment(),
  );
  await second.worker.fetch(
    await signedRequest(validPayload(), {
      nonce: 'nonce-for-second-day01',
      timestamp: secondTimestamp,
    }),
    environment(),
  );

  assert.notEqual(
    [...first.store.records.values()][0]?.dailyIdHash,
    [...second.store.records.values()][0]?.dailyIdHash,
  );
});

test('rejects nonce replay atomically', async () => {
  const { worker, store } = harness();
  const first = await worker.fetch(
    await signedRequest(validPayload(), { nonce: 'same-nonce-for-replay1' }),
    environment(),
  );
  const replay = await worker.fetch(
    await signedRequest(validPayload(), { nonce: 'same-nonce-for-replay1' }),
    environment(),
  );

  assert.equal(first.status, 202);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), {
    ok: false,
    error: 'replay_detected',
  });
  assert.equal(store.records.size, 1);
});

test('rejects invalid signatures, stale timestamps, and unknown keys', async () => {
  const { worker, store } = harness();
  const invalidSignature = await signedRequest(validPayload(), {
    nonce: 'bad-signature-nonce-01',
    signature: '0'.repeat(64),
  });
  const stale = await signedRequest(validPayload(), {
    nonce: 'stale-timestamp-nonce1',
    timestamp: String(Number(TIMESTAMP) - 301),
  });
  const unknown = await signedRequest(validPayload(), {
    keyId: 'unknown-key',
    nonce: 'unknown-key-id-nonce01',
  });

  assert.equal((await worker.fetch(invalidSignature, environment())).status, 401);
  assert.equal((await worker.fetch(stale, environment())).status, 401);
  assert.equal((await worker.fetch(unknown, environment())).status, 401);
  assert.equal(store.nonces.size, 0);
  assert.equal(store.records.size, 0);
});

test('accepts the previous HMAC key during rotation', async () => {
  const { worker, store } = harness();
  const response = await worker.fetch(
    await signedRequest(validPayload(), {
      keyId: 'previous',
      nonce: 'previous-key-nonce-001',
      secret: PREVIOUS_SECRET,
    }),
    environment(),
  );

  assert.equal(response.status, 202);
  assert.equal(store.records.size, 1);
});

test('authenticates raw bytes before returning strict schema errors', async () => {
  const { worker, store } = harness();
  const response = await worker.fetch(
    await signedRequest({ ...validPayload(), original_text: 'must not exist' }, {
      nonce: 'invalid-payload-nonce1',
    }),
    environment(),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'invalid_payload',
  });
  assert.equal(store.nonces.size, 0);
});

test('enforces content type and the actual 512-byte body limit', async () => {
  const { worker } = harness();
  const wrongType = new Request('https://telemetry.example/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  const oversized = new Request('https://telemetry.example/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(513),
  });

  assert.equal((await worker.fetch(wrongType, environment())).status, 415);
  assert.equal((await worker.fetch(oversized, environment())).status, 413);
});

test('does not accept query parameters or other methods on ingestion', async () => {
  const { worker } = harness();
  const query = new Request('https://telemetry.example/v1/events?debug=1', {
    method: 'POST',
  });
  const get = new Request('https://telemetry.example/v1/events');

  assert.equal((await worker.fetch(query, environment())).status, 400);
  const methodResponse = await worker.fetch(get, environment());
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'POST');
});

test('health is public but admin requires a valid Access assertion', async () => {
  const store = new MemoryStore();
  const worker = createWorker({
    now: () => new Date(NOW),
    storeFactory: () => store,
    verifyAdmin: async (assertion) => assertion === 'valid-access-token',
  });
  const health = await worker.fetch(
    new Request('https://telemetry.example/healthz'),
    environment(),
  );
  const denied = await worker.fetch(
    new Request('https://telemetry.example/admin'),
    environment(),
  );
  const allowed = await worker.fetch(
    new Request('https://telemetry.example/admin', {
      headers: { 'cf-access-jwt-assertion': 'valid-access-token' },
    }),
    environment(),
  );

  assert.equal(health.status, 200);
  assert.equal(denied.status, 403);
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /ZeroClave Telemetry/);
  assert.match(allowed.headers.get('content-security-policy') ?? '', /default-src 'none'/);
});

test('serves aggregate admin data without raw identifiers', async () => {
  const { worker, store } = harness();
  store.summary = [
    {
      day: '2026-09-18',
      event: '*',
      value: '*',
      plugin_version: '*',
      unique_profiles: 12,
    },
  ];
  const response = await worker.fetch(
    new Request('https://telemetry.example/admin/api/summary?days=7', {
      headers: { 'cf-access-jwt-assertion': 'valid' },
    }),
    environment(),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /"unique_profiles":12/);
  assert.equal(body.includes('daily_id'), false);
});

test('scheduled handler runs rollup and retention maintenance', async () => {
  const { worker, store } = harness();
  await worker.scheduled(
    { scheduledTime: NOW.getTime() },
    environment(),
  );
  assert.equal(store.maintenanceAt?.toISOString(), NOW.toISOString());
});

function harness(current = NOW): {
  store: MemoryStore;
  worker: ReturnType<typeof createWorker>;
} {
  const store = new MemoryStore();
  return {
    store,
    worker: createWorker({
      now: () => new Date(current),
      storeFactory: () => store,
      verifyAdmin: async (assertion) => Boolean(assertion),
    }),
  };
}

function environment(): Env {
  return {
    DB: null as unknown as D1Database,
    INGEST_KEY_ID: 'current',
    INGEST_HMAC_SECRET: CURRENT_SECRET,
    INGEST_PREVIOUS_KEY_ID: 'previous',
    INGEST_PREVIOUS_HMAC_SECRET: PREVIOUS_SECRET,
    DAILY_ID_HMAC_SECRET: DAILY_SECRET,
    CF_ACCESS_TEAM_DOMAIN: 'https://zeroclave.cloudflareaccess.com',
    CF_ACCESS_AUD: 'admin-audience',
  };
}

function validPayload(): Record<string, unknown> {
  return {
    schema_version: 1,
    product: PRODUCT,
    event: 'privacy_active',
    daily_id: DAILY_ID,
    plugin_version: '0.1.0-alpha.11',
  };
}

async function signedRequest(
  payload: unknown,
  options: {
    keyId?: string;
    nonce: string;
    secret?: string;
    signature?: string;
    timestamp?: string;
  },
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? TIMESTAMP;
  const signature =
    options.signature ??
    (await hmacHex(
      options.secret ?? CURRENT_SECRET,
      canonicalRequest(
        timestamp,
        options.nonce,
        await sha256Hex(new TextEncoder().encode(body)),
      ),
    ));

  return new Request('https://telemetry.example/v1/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-zc-key-id': options.keyId ?? 'current',
      'x-zc-nonce': options.nonce,
      'x-zc-signature': signature,
      'x-zc-timestamp': timestamp,
    },
    body,
  });
}

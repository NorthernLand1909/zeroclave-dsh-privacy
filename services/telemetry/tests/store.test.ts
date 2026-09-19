import assert from 'node:assert/strict';
import test from 'node:test';

import { RAW_RETENTION_SECONDS } from '../src/contracts.ts';
import { D1TelemetryStore } from '../src/store.ts';

interface FakeResult {
  results?: unknown[];
  changes?: number;
}

class FakeStatement {
  bindings: unknown[] = [];
  readonly sql: string;
  private readonly result: FakeResult;

  constructor(sql: string, result: FakeResult = {}) {
    this.sql = sql;
    this.result = result;
  }

  bind(...values: unknown[]): this {
    this.bindings = values;
    return this;
  }

  async run(): Promise<unknown> {
    return { meta: { changes: this.result.changes ?? 0 } };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: (this.result.results ?? []) as T[] };
  }
}

class FakeDatabase {
  readonly statements: FakeStatement[] = [];
  readonly batches: FakeStatement[][] = [];
  nonceChanges = 1;
  hasCompletedDayRollup = false;

  prepare(sql: string): FakeStatement {
    let result: FakeResult = {};
    if (sql.includes('INSERT INTO telemetry_nonces')) {
      result = { changes: this.nonceChanges };
    } else if (sql.includes('SELECT DISTINCT day')) {
      result = {
        results: this.hasCompletedDayRollup ? [] : [{ day: '2026-09-17' }],
      };
    } else if (sql.includes('FROM telemetry_rollups') && !sql.includes('NOT EXISTS')) {
      result = {
        results: [
          {
            day: '2026-09-17',
            event: '*',
            value: '*',
            plugin_version: '*',
            unique_profiles: 4,
          },
        ],
      };
    } else if (sql.includes('WITH unrolled')) {
      result = {
        results: [
          {
            day: '2026-09-18',
            event: '*',
            value: '*',
            plugin_version: '*',
            unique_profiles: 2,
          },
        ],
      };
    }
    const statement = new FakeStatement(sql, result);
    this.statements.push(statement);
    return statement;
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.batches.push(statements);
    if (statements.some((statement) => statement.sql.includes("SELECT day, '*', '*', '*'"))) {
      this.hasCompletedDayRollup = true;
    }
    return statements.map(() => ({ success: true }));
  }
}

test('uses a unique insert to claim nonces atomically', async () => {
  const db = new FakeDatabase();
  const store = new D1TelemetryStore(db as unknown as D1Database);

  assert.equal(await store.claimNonce('key', 'a'.repeat(64), 10, 20), true);
  db.nonceChanges = 0;
  assert.equal(await store.claimNonce('key', 'a'.repeat(64), 10, 20), false);
  assert.match(db.statements[0]?.sql ?? '', /ON CONFLICT .* DO NOTHING/s);
});

test('upserts exact-dedupe rows by day, event, value, and daily hash', async () => {
  const db = new FakeDatabase();
  const store = new D1TelemetryStore(db as unknown as D1Database);
  await store.recordEvent({
    day: '2026-09-18',
    event: 'privacy_active',
    value: '',
    dailyIdHash: 'b'.repeat(64),
    pluginVersion: '0.1.0-alpha.11',
    receivedAt: 100,
  });

  const statement = db.statements.at(-1);
  assert.match(statement?.sql ?? '', /ON CONFLICT \(day, event, value, daily_id_hash\)/);
  assert.deepEqual(statement?.bindings, [
    '2026-09-18',
    'privacy_active',
    '',
    'b'.repeat(64),
    '0.1.0-alpha.11',
    100,
    100,
  ]);
});

test('merges persisted rollups with unrolled live days', async () => {
  const db = new FakeDatabase();
  const store = new D1TelemetryStore(db as unknown as D1Database);
  const rows = await store.getSummary('2026-09-12', '2026-09-18');

  assert.deepEqual(
    rows.map((row) => [row.day, row.unique_profiles]),
    [
      ['2026-09-17', 4],
      ['2026-09-18', 2],
    ],
  );
});

test('rolls up complete UTC days before deleting raw rows older than 48 hours', async () => {
  const db = new FakeDatabase();
  const store = new D1TelemetryStore(db as unknown as D1Database);
  const now = new Date('2026-09-18T00:15:00.000Z');
  await store.runMaintenance(now);

  assert.equal(db.batches.length, 2);
  assert.equal(db.batches[0]?.length, 4, 'four immutable aggregate levels');
  assert.equal(db.batches[1]?.length, 2, 'nonce and raw event cleanup');
  const cleanup = db.batches[1]?.[1];
  assert.deepEqual(cleanup?.bindings, [
    Math.floor(now.getTime() / 1000) - RAW_RETENTION_SECONDS,
  ]);

  await store.runMaintenance(new Date('2026-09-18T01:15:00.000Z'));
  assert.equal(db.batches.length, 3, 'the second run performs cleanup only');
  assert.equal(db.batches[2]?.length, 2);
  assert.match(
    db.statements.find((statement) => statement.sql.includes('SELECT DISTINCT day'))
      ?.sql ?? '',
    /NOT EXISTS/,
  );
});

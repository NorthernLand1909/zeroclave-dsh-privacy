import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import test from 'node:test';

import { D1TelemetryStore } from '../src/store.ts';

class SqliteStatement {
  private bindings: SQLInputValue[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: unknown[]): this {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  async run(): Promise<unknown> {
    const result = this.statement.run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.bindings) as T[] };
  }
}

class SqliteDatabase {
  readonly database = new DatabaseSync(':memory:');

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql));
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

test('real SQLite rollup is immutable while raw rows age out', async () => {
  const database = new SqliteDatabase();
  const migration = await readFile(
    new URL('../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  database.database.exec(migration);
  const store = new D1TelemetryStore(database as unknown as D1Database);
  const firstReceived = Math.floor(
    new Date('2026-09-18T10:00:00.000Z').getTime() / 1000,
  );

  await store.recordEvent({
    day: '2026-09-18',
    event: 'privacy_active',
    value: '',
    dailyIdHash: 'a'.repeat(64),
    pluginVersion: '0.1.0-alpha.11',
    receivedAt: firstReceived,
  });
  await store.recordEvent({
    day: '2026-09-18',
    event: 'privacy_active',
    value: '',
    dailyIdHash: 'b'.repeat(64),
    pluginVersion: '0.1.0-alpha.11',
    receivedAt: firstReceived,
  });
  await store.recordEvent({
    day: '2026-09-18',
    event: 'protected_send',
    value: '',
    dailyIdHash: 'a'.repeat(64),
    pluginVersion: '0.1.0-alpha.11',
    receivedAt: firstReceived,
  });

  await store.runMaintenance(new Date('2026-09-19T00:15:00.000Z'));
  assert.equal(readPrivacyActiveRollup(database.database), 2);

  database.database
    .prepare('DELETE FROM telemetry_events WHERE daily_id_hash = ?')
    .run('a'.repeat(64));
  await store.runMaintenance(new Date('2026-09-19T01:15:00.000Z'));
  assert.equal(
    readPrivacyActiveRollup(database.database),
    2,
    'partial raw deletion must never shrink a sealed rollup',
  );

  await store.runMaintenance(new Date('2026-09-21T00:15:00.000Z'));
  const rawCount = database.database
    .prepare('SELECT COUNT(*) AS count FROM telemetry_events')
    .get() as { count: number };
  assert.equal(rawCount.count, 0);
  assert.equal(readPrivacyActiveRollup(database.database), 2);
});

test('real SQLite enforces atomic nonce replay claims', async () => {
  const database = new SqliteDatabase();
  database.database.exec(
    await readFile(
      new URL('../migrations/0001_initial.sql', import.meta.url),
      'utf8',
    ),
  );
  const store = new D1TelemetryStore(database as unknown as D1Database);

  assert.equal(await store.claimNonce('key', 'c'.repeat(64), 100, 700), true);
  assert.equal(await store.claimNonce('key', 'c'.repeat(64), 100, 700), false);
});

function readPrivacyActiveRollup(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT unique_profiles
       FROM telemetry_rollups
       WHERE day = '2026-09-18'
         AND event = 'privacy_active'
         AND value = '*'
         AND plugin_version = '*'`,
    )
    .get() as { unique_profiles: number } | undefined;
  assert.ok(row);
  return row.unique_profiles;
}

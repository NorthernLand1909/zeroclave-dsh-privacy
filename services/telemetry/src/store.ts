import {
  RAW_RETENTION_SECONDS,
  type SummaryRow,
  type TelemetryRecord,
} from './contracts.ts';

export interface TelemetryStore {
  claimNonce(
    keyId: string,
    nonceHash: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<boolean>;
  recordEvent(record: TelemetryRecord): Promise<void>;
  getSummary(fromDay: string, toDay: string): Promise<SummaryRow[]>;
  runMaintenance(now: Date): Promise<void>;
}

export class D1TelemetryStore implements TelemetryStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async claimNonce(
    keyId: string,
    nonceHash: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO telemetry_nonces (key_id, nonce_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (key_id, nonce_hash) DO NOTHING`,
      )
      .bind(keyId, nonceHash, createdAt, expiresAt)
      .run();

    return result.meta.changes === 1;
  }

  async recordEvent(record: TelemetryRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO telemetry_events (
           day, event, value, daily_id_hash, plugin_version,
           first_received_at, last_received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, event, value, daily_id_hash) DO UPDATE SET
           plugin_version = excluded.plugin_version,
           last_received_at = excluded.last_received_at`,
      )
      .bind(
        record.day,
        record.event,
        record.value,
        record.dailyIdHash,
        record.pluginVersion,
        record.receivedAt,
        record.receivedAt,
      )
      .run();
  }

  async getSummary(fromDay: string, toDay: string): Promise<SummaryRow[]> {
    const [rollups, live] = await Promise.all([
      this.db
        .prepare(
          `SELECT day, event, value, plugin_version, unique_profiles
           FROM telemetry_rollups
           WHERE day BETWEEN ? AND ?`,
        )
        .bind(fromDay, toDay)
        .all<SummaryRow>(),
      this.db
        .prepare(
          `WITH unrolled AS (
             SELECT e.*
             FROM telemetry_events e
             WHERE e.day BETWEEN ? AND ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM telemetry_rollups r
                 WHERE r.day = e.day
                   AND r.event = '*'
                   AND r.value = '*'
                   AND r.plugin_version = '*'
               )
           )
           SELECT day, '*' AS event, '*' AS value, '*' AS plugin_version,
                  COUNT(DISTINCT daily_id_hash) AS unique_profiles
           FROM unrolled GROUP BY day
           UNION ALL
           SELECT day, event, '*' AS value, '*' AS plugin_version,
                  COUNT(DISTINCT daily_id_hash) AS unique_profiles
           FROM unrolled GROUP BY day, event
           UNION ALL
           SELECT day, event, value, '*' AS plugin_version,
                  COUNT(DISTINCT daily_id_hash) AS unique_profiles
           FROM unrolled GROUP BY day, event, value
           UNION ALL
           SELECT day, event, value, plugin_version,
                  COUNT(DISTINCT daily_id_hash) AS unique_profiles
           FROM unrolled GROUP BY day, event, value, plugin_version`,
        )
        .bind(fromDay, toDay)
        .all<SummaryRow>(),
    ]);

    return [...(rollups.results ?? []), ...(live.results ?? [])].sort(
      compareSummaryRows,
    );
  }

  async runMaintenance(now: Date): Promise<void> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const today = utcDay(now);
    const daysResult = await this.db
      .prepare(
        `SELECT DISTINCT day
         FROM telemetry_events
         WHERE day < ?
           AND NOT EXISTS (
             SELECT 1
             FROM telemetry_rollups r
             WHERE r.day = telemetry_events.day
               AND r.event = '*'
               AND r.value = '*'
               AND r.plugin_version = '*'
           )
         ORDER BY day DESC
         LIMIT 32`,
      )
      .bind(today)
      .all<{ day: string }>();

    for (const row of daysResult.results ?? []) {
      await this.rollupDay(row.day, nowSeconds);
    }

    await this.db.batch([
      this.db
        .prepare('DELETE FROM telemetry_nonces WHERE expires_at <= ?')
        .bind(nowSeconds),
      this.db
        .prepare('DELETE FROM telemetry_events WHERE first_received_at < ?')
        .bind(nowSeconds - RAW_RETENTION_SECONDS),
    ]);
  }

  private async rollupDay(day: string, generatedAt: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO telemetry_rollups (
             day, event, value, plugin_version, unique_profiles, generated_at
           )
           SELECT day, '*', '*', '*', COUNT(DISTINCT daily_id_hash), ?
           FROM telemetry_events
           WHERE day = ?
           GROUP BY day
           ON CONFLICT (day, event, value, plugin_version) DO NOTHING`,
        )
        .bind(generatedAt, day),
      this.db
        .prepare(
          `INSERT INTO telemetry_rollups (
             day, event, value, plugin_version, unique_profiles, generated_at
           )
           SELECT day, event, '*', '*', COUNT(DISTINCT daily_id_hash), ?
           FROM telemetry_events
           WHERE day = ?
           GROUP BY day, event
           ON CONFLICT (day, event, value, plugin_version) DO NOTHING`,
        )
        .bind(generatedAt, day),
      this.db
        .prepare(
          `INSERT INTO telemetry_rollups (
             day, event, value, plugin_version, unique_profiles, generated_at
           )
           SELECT day, event, value, '*', COUNT(DISTINCT daily_id_hash), ?
           FROM telemetry_events
           WHERE day = ?
           GROUP BY day, event, value
           ON CONFLICT (day, event, value, plugin_version) DO NOTHING`,
        )
        .bind(generatedAt, day),
      this.db
        .prepare(
          `INSERT INTO telemetry_rollups (
             day, event, value, plugin_version, unique_profiles, generated_at
           )
           SELECT day, event, value, plugin_version,
                  COUNT(DISTINCT daily_id_hash), ?
           FROM telemetry_events
           WHERE day = ?
           GROUP BY day, event, value, plugin_version
           ON CONFLICT (day, event, value, plugin_version) DO NOTHING`,
        )
        .bind(generatedAt, day),
    ]);
  }
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compareSummaryRows(left: SummaryRow, right: SummaryRow): number {
  return (
    left.day.localeCompare(right.day) ||
    left.event.localeCompare(right.event) ||
    left.value.localeCompare(right.value) ||
    left.plugin_version.localeCompare(right.plugin_version)
  );
}

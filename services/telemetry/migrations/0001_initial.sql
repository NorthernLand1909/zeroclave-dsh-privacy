CREATE TABLE telemetry_events (
  day TEXT NOT NULL CHECK(length(day) = 10),
  event TEXT NOT NULL,
  value TEXT NOT NULL,
  daily_id_hash TEXT NOT NULL CHECK(length(daily_id_hash) = 64),
  plugin_version TEXT NOT NULL,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  PRIMARY KEY (day, event, value, daily_id_hash)
) WITHOUT ROWID;

CREATE INDEX telemetry_events_received_at_idx
  ON telemetry_events(first_received_at);

CREATE TABLE telemetry_nonces (
  key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce_hash)
) WITHOUT ROWID;

CREATE INDEX telemetry_nonces_expires_at_idx
  ON telemetry_nonces(expires_at);

CREATE TABLE telemetry_rollups (
  day TEXT NOT NULL CHECK(length(day) = 10),
  event TEXT NOT NULL,
  value TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  unique_profiles INTEGER NOT NULL CHECK(unique_profiles >= 0),
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (day, event, value, plugin_version)
) WITHOUT ROWID;

CREATE INDEX telemetry_rollups_day_idx
  ON telemetry_rollups(day);

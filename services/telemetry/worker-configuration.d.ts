interface Env {
  DB: D1Database;
  INGEST_KEY_ID: string;
  INGEST_HMAC_SECRET: string;
  INGEST_PREVIOUS_KEY_ID?: string;
  INGEST_PREVIOUS_HMAC_SECRET?: string;
  DAILY_ID_HMAC_SECRET: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}

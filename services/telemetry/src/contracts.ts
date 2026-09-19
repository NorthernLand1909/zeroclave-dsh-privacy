export const PRODUCT = 'zeroclave-dsh-privacy' as const;
export const SCHEMA_VERSION = 1 as const;
export const MAX_BODY_BYTES = 512;
export const AUTH_CLOCK_SKEW_SECONDS = 300;
export const NONCE_TTL_SECONDS = 600;
export const RAW_RETENTION_SECONDS = 48 * 60 * 60;

export const EVENT_VALUES = {
  privacy_active: null,
  protected_send: null,
  detector_used: ['regex', 'embedded', 'zeroclave'],
} as const;

export type TelemetryEvent = keyof typeof EVENT_VALUES;

export interface TelemetryPayload {
  schema_version: typeof SCHEMA_VERSION;
  product: typeof PRODUCT;
  event: TelemetryEvent;
  daily_id: string;
  plugin_version: string;
  value?: string;
}

export interface TelemetryRecord {
  day: string;
  event: TelemetryEvent;
  value: string;
  dailyIdHash: string;
  pluginVersion: string;
  receivedAt: number;
}

export interface SummaryRow {
  day: string;
  event: string;
  value: string;
  plugin_version: string;
  unique_profiles: number;
}

export interface AdminSummary {
  generated_at: string;
  range: {
    from: string;
    to: string;
    days: number;
  };
  rows: SummaryRow[];
}

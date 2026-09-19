import {
  EVENT_VALUES,
  PRODUCT,
  SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetryPayload,
} from './contracts.ts';

const DAILY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class PayloadValidationError extends Error {
  constructor() {
    super('invalid_payload');
    this.name = 'PayloadValidationError';
  }
}

export function parseTelemetryPayload(value: unknown): TelemetryPayload {
  if (!isRecord(value)) {
    throw new PayloadValidationError();
  }

  const allowedKeys = new Set([
    'schema_version',
    'product',
    'event',
    'daily_id',
    'plugin_version',
    'value',
  ]);
  const keys = Object.keys(value);

  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new PayloadValidationError();
  }

  if (
    value.schema_version !== SCHEMA_VERSION ||
    value.product !== PRODUCT ||
    typeof value.event !== 'string' ||
    !Object.hasOwn(EVENT_VALUES, value.event) ||
    typeof value.daily_id !== 'string' ||
    !isCanonicalDailyId(value.daily_id) ||
    typeof value.plugin_version !== 'string' ||
    value.plugin_version.length > 64 ||
    !VERSION_PATTERN.test(value.plugin_version)
  ) {
    throw new PayloadValidationError();
  }

  const event = value.event as TelemetryEvent;
  const allowedValues = EVENT_VALUES[event];

  if (allowedValues === null) {
    if (Object.hasOwn(value, 'value')) {
      throw new PayloadValidationError();
    }
  } else if (
    typeof value.value !== 'string' ||
    !(allowedValues as readonly string[]).includes(value.value)
  ) {
    throw new PayloadValidationError();
  }

  return {
    schema_version: SCHEMA_VERSION,
    product: PRODUCT,
    event,
    daily_id: value.daily_id,
    plugin_version: value.plugin_version,
    ...(allowedValues === null ? {} : { value: value.value as string }),
  };
}

function isCanonicalDailyId(value: string): boolean {
  if (!DAILY_ID_PATTERN.test(value)) {
    return false;
  }

  try {
    const bytes = decodeBase64Url(value);
    return bytes.byteLength === 16 && encodeBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '==';
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

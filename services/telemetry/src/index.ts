import { verifyCloudflareAccess } from './access.ts';
import { ADMIN_HTML, ADMIN_JS } from './admin.ts';
import {
  AUTH_CLOCK_SKEW_SECONDS,
  MAX_BODY_BYTES,
  NONCE_TTL_SECONDS,
  type AdminSummary,
  type TelemetryPayload,
} from './contracts.ts';
import {
  canonicalRequest,
  hmacHex,
  sha256Hex,
  verifyHmacHex,
} from './crypto.ts';
import { jsonResponse, textResponse } from './responses.ts';
import {
  PayloadValidationError,
  parseTelemetryPayload,
} from './schema.ts';
import {
  D1TelemetryStore,
  type TelemetryStore,
  utcDay,
} from './store.ts';

const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP_PATTERN = /^[1-9]\d{9,10}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const ADMIN_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
].join('; ');

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledControllerLike {
  scheduledTime: number;
}

interface WorkerDependencies {
  fetcher?: typeof fetch;
  now?: () => Date;
  storeFactory?: (env: Env) => TelemetryStore;
  verifyAdmin?: (
    assertion: string | null,
    env: Env,
    now: Date,
  ) => Promise<boolean>;
}

interface TelemetryWorker {
  fetch(request: Request, env: Env, context?: ExecutionContextLike): Promise<Response>;
  scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    context?: ExecutionContextLike,
  ): Promise<void>;
}

class BodyTooLargeError extends Error {}
class BodyReadError extends Error {}

export function createWorker(
  dependencies: WorkerDependencies = {},
): TelemetryWorker {
  const now = dependencies.now ?? (() => new Date());
  const fetcher = dependencies.fetcher ?? fetch;
  const storeFactory =
    dependencies.storeFactory ?? ((env: Env) => new D1TelemetryStore(env.DB));
  const verifyAdmin =
    dependencies.verifyAdmin ??
    (async (assertion: string | null, env: Env, currentTime: Date) =>
      (await verifyCloudflareAccess(
        assertion,
        {
          audience: env.CF_ACCESS_AUD,
          teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        },
        currentTime,
        fetcher,
      )) !== null);

  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return methodNotAllowed('GET, HEAD');
        }
        const response = jsonResponse({
          ok: true,
          service: 'zeroclave-telemetry',
          schema_version: 1,
        });
        return request.method === 'HEAD'
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      }

      if (url.pathname === '/v1/events') {
        if (request.method !== 'POST') {
          return methodNotAllowed('POST');
        }
        if (url.search) {
          return jsonResponse({ ok: false, error: 'invalid_request' }, 400);
        }
        return handleEvent(request, env, storeFactory(env), now());
      }

      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return methodNotAllowed('GET, HEAD');
        }

        if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
          return jsonResponse(
            { ok: false, error: 'admin_not_configured' },
            503,
          );
        }

        const authorized = await verifyAdmin(
          request.headers.get('cf-access-jwt-assertion'),
          env,
          now(),
        );
        if (!authorized) {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403);
        }

        return handleAdmin(request, url, storeFactory(env), now());
      }

      return jsonResponse({ ok: false, error: 'not_found' }, 404);
    },

    async scheduled(controller, env): Promise<void> {
      await storeFactory(env).runMaintenance(new Date(controller.scheduledTime));
    },
  };
}

async function handleEvent(
  request: Request,
  env: Env,
  store: TelemetryStore,
  now: Date,
): Promise<Response> {
  if (!JSON_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) {
    return jsonResponse({ ok: false, error: 'unsupported_media_type' }, 415);
  }
  const contentEncoding = request.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    return jsonResponse({ ok: false, error: 'unsupported_content_encoding' }, 415);
  }

  const statedLength = request.headers.get('content-length');
  if (statedLength) {
    if (!/^\d+$/.test(statedLength)) {
      return jsonResponse({ ok: false, error: 'invalid_request' }, 400);
    }
    if (Number(statedLength) > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: 'payload_too_large' }, 413);
    }
  }

  let body: Uint8Array;
  try {
    body = await readLimitedBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse({ ok: false, error: 'payload_too_large' }, 413);
    }
    return jsonResponse({ ok: false, error: 'invalid_request' }, 400);
  }

  const auth = readAuthHeaders(request.headers);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!auth || Math.abs(nowSeconds - auth.timestampNumber) > AUTH_CLOCK_SKEW_SECONDS) {
    return invalidAuth();
  }

  const secret = selectAuthSecret(env, auth.keyId);
  if (!secret) {
    return invalidAuth();
  }
  if (
    typeof env.DAILY_ID_HMAC_SECRET !== 'string' ||
    env.DAILY_ID_HMAC_SECRET.length < 32
  ) {
    return jsonResponse({ ok: false, error: 'service_not_configured' }, 503);
  }

  const bodyDigest = await sha256Hex(body);
  const canonical = canonicalRequest(auth.timestamp, auth.nonce, bodyDigest);
  if (!(await verifyHmacHex(secret, canonical, auth.signature))) {
    return invalidAuth();
  }

  let payload: TelemetryPayload;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload = parseTelemetryPayload(JSON.parse(text) as unknown);
  } catch (error) {
    if (
      error instanceof PayloadValidationError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    ) {
      return jsonResponse({ ok: false, error: 'invalid_payload' }, 422);
    }
    return jsonResponse({ ok: false, error: 'invalid_payload' }, 422);
  }

  try {
    const nonceHash = await sha256Hex(`${auth.keyId}\n${auth.nonce}`);
    const nonceClaimed = await store.claimNonce(
      auth.keyId,
      nonceHash,
      nowSeconds,
      nowSeconds + NONCE_TTL_SECONDS,
    );
    if (!nonceClaimed) {
      return jsonResponse({ ok: false, error: 'replay_detected' }, 409);
    }

    const day = utcDay(now);
    const dailyIdHash = await hmacHex(
      env.DAILY_ID_HMAC_SECRET,
      `${day}\n${payload.daily_id}`,
    );
    await store.recordEvent({
      day,
      event: payload.event,
      value: payload.value ?? '',
      dailyIdHash,
      pluginVersion: payload.plugin_version,
      receivedAt: nowSeconds,
    });
  } catch {
    return jsonResponse({ ok: false, error: 'temporarily_unavailable' }, 503);
  }

  return jsonResponse({ ok: true }, 202);
}

async function handleAdmin(
  request: Request,
  url: URL,
  store: TelemetryStore,
  now: Date,
): Promise<Response> {
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const response = textResponse(ADMIN_HTML, 'text/html; charset=utf-8', {
      'content-security-policy': ADMIN_CSP,
      'permissions-policy':
        'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    });
    return request.method === 'HEAD'
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }

  if (url.pathname === '/admin/app.js') {
    const response = textResponse(
      ADMIN_JS,
      'text/javascript; charset=utf-8',
      { 'content-security-policy': ADMIN_CSP },
    );
    return request.method === 'HEAD'
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }

  if (url.pathname === '/admin/api/summary') {
    const daysValue = url.searchParams.get('days') ?? '30';
    if (!/^\d{1,2}$/.test(daysValue)) {
      return jsonResponse({ ok: false, error: 'invalid_range' }, 400);
    }
    const days = Number(daysValue);
    if (days < 1 || days > 90) {
      return jsonResponse({ ok: false, error: 'invalid_range' }, 400);
    }

    const to = utcDay(now);
    const fromDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
    const from = utcDay(fromDate);

    try {
      const summary: AdminSummary = {
        generated_at: now.toISOString(),
        range: { from, to, days },
        rows: await store.getSummary(from, to),
      };
      const response = jsonResponse(summary);
      return request.method === 'HEAD'
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    } catch {
      return jsonResponse({ ok: false, error: 'temporarily_unavailable' }, 503);
    }
  }

  return jsonResponse({ ok: false, error: 'not_found' }, 404);
}

function readAuthHeaders(headers: Headers): {
  keyId: string;
  nonce: string;
  signature: string;
  timestamp: string;
  timestampNumber: number;
} | null {
  const keyId = headers.get('x-zc-key-id') ?? '';
  const nonce = headers.get('x-zc-nonce') ?? '';
  const signature = headers.get('x-zc-signature') ?? '';
  const timestamp = headers.get('x-zc-timestamp') ?? '';

  if (
    !KEY_ID_PATTERN.test(keyId) ||
    !NONCE_PATTERN.test(nonce) ||
    !SIGNATURE_PATTERN.test(signature) ||
    !TIMESTAMP_PATTERN.test(timestamp)
  ) {
    return null;
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber)) {
    return null;
  }

  return { keyId, nonce, signature, timestamp, timestampNumber };
}

function selectAuthSecret(env: Env, keyId: string): string | null {
  if (
    keyId === env.INGEST_KEY_ID &&
    typeof env.INGEST_HMAC_SECRET === 'string' &&
    env.INGEST_HMAC_SECRET.length >= 32
  ) {
    return env.INGEST_HMAC_SECRET;
  }
  if (
    keyId === env.INGEST_PREVIOUS_KEY_ID &&
    typeof env.INGEST_PREVIOUS_HMAC_SECRET === 'string' &&
    env.INGEST_PREVIOUS_HMAC_SECRET.length >= 32
  ) {
    return env.INGEST_PREVIOUS_HMAC_SECRET;
  }
  return null;
}

async function readLimitedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw error;
    }
    throw new BodyReadError();
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function invalidAuth(): Response {
  return jsonResponse({ ok: false, error: 'invalid_auth' }, 401);
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, {
    allow,
  });
}

const worker = createWorker();
export default worker;

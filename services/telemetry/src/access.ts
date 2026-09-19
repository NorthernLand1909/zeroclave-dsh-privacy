interface AccessHeader {
  alg?: unknown;
  kid?: unknown;
}

interface AccessClaims {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
}

interface CachedKeys {
  expiresAt: number;
  keys: AccessJwk[];
}

type AccessJwk = JsonWebKey & { kid: string };

const keyCache = new Map<string, CachedKeys>();
const ACCESS_KEY_CACHE_MS = 5 * 60 * 1000;

export interface AccessConfiguration {
  audience: string;
  teamDomain: string;
}

export interface AccessIdentity {
  email?: string;
  subject: string;
}

export async function verifyCloudflareAccess(
  assertion: string | null,
  configuration: AccessConfiguration,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity | null> {
  try {
    if (!assertion) {
      return null;
    }

    const issuer = normalizeTeamDomain(configuration.teamDomain);
    if (!issuer || !configuration.audience) {
      return null;
    }

    const segments = assertion.split('.');
    if (segments.length !== 3) {
      return null;
    }

    const header = decodeJwtPart<AccessHeader>(segments[0] ?? '');
    const claims = decodeJwtPart<AccessClaims>(segments[1] ?? '');
    const signature = decodeBase64Url(segments[2] ?? '');
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !isValidClaims(claims, configuration.audience, issuer, now)
    ) {
      return null;
    }

    const keys = await loadKeys(issuer, now, fetcher);
    let jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      keyCache.delete(issuer);
      jwk = (await loadKeys(issuer, now, fetcher)).find(
        (candidate) => candidate.kid === header.kid,
      );
    }
    if (!jwk) {
      return null;
    }

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signed = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      ownedArrayBuffer(signature),
      signed,
    );

    if (!valid) {
      return null;
    }

    return {
      subject: claims.sub as string,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    };
  } catch {
    return null;
  }
}

export function clearAccessKeyCacheForTests(): void {
  keyCache.clear();
}

async function loadKeys(
  issuer: string,
  now: Date,
  fetcher: typeof fetch,
): Promise<AccessJwk[]> {
  const cached = keyCache.get(issuer);
  if (cached && cached.expiresAt > now.getTime()) {
    return cached.keys;
  }

  const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error('access_keys_unavailable');
  }

  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) {
    throw new Error('access_keys_invalid');
  }

  const keys = body.keys.filter(isJsonWebKey);
  keyCache.set(issuer, {
    expiresAt: now.getTime() + ACCESS_KEY_CACHE_MS,
    keys,
  });
  return keys;
}

function isValidClaims(
  claims: AccessClaims,
  audience: string,
  issuer: string,
  now: Date,
): boolean {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  return (
    audiences.includes(audience) &&
    claims.iss === issuer &&
    typeof claims.sub === 'string' &&
    claims.sub.length > 0 &&
    typeof claims.exp === 'number' &&
    Number.isInteger(claims.exp) &&
    claims.exp > nowSeconds &&
    (claims.nbf === undefined ||
      (typeof claims.nbf === 'number' && claims.nbf <= nowSeconds + 30))
  );
}

function normalizeTeamDomain(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname.endsWith('.cloudflareaccess.com')
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function decodeJwtPart<T>(value: string): T {
  const decoded = decodeBase64Url(value);
  const json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  return JSON.parse(json) as T;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid_base64url');
  }

  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + padding,
  );
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) {
    throw new Error('noncanonical_base64url');
  }
  return bytes;
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

function isJsonWebKey(value: unknown): value is AccessJwk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kid' in value &&
    typeof value.kid === 'string' &&
    'kty' in value &&
    value.kty === 'RSA'
  );
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

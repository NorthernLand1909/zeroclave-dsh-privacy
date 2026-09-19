const encoder = new TextEncoder();

export function canonicalRequest(
  timestamp: string,
  nonce: string,
  bodyDigest: string,
): string {
  return ['v1', 'POST', '/v1/events', timestamp, nonce, bodyDigest].join('\n');
}

export async function sha256Hex(
  value: string | Uint8Array,
): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', ownedArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacHex(
  secret: string,
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyHmacHex(
  secret: string,
  value: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);
  if (!signature) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    ownedArrayBuffer(signature),
    encoder.encode(value),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return null;
  }

  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

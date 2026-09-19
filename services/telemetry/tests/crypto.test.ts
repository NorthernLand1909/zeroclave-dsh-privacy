import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canonicalRequest,
  hmacHex,
  sha256Hex,
  verifyHmacHex,
} from '../src/crypto.ts';

test('builds the request canonical form without normalization', () => {
  assert.equal(
    canonicalRequest('1789696800', 'abcdefghijklmnop', 'abc123'),
    'v1\nPOST\n/v1/events\n1789696800\nabcdefghijklmnop\nabc123',
  );
});

test('creates and verifies lowercase hex HMAC-SHA256 signatures', async () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const signature = await hmacHex(secret, 'signed value');

  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(await verifyHmacHex(secret, 'signed value', signature), true);
  assert.equal(await verifyHmacHex(secret, 'changed value', signature), false);
  assert.equal(await verifyHmacHex(secret, 'signed value', signature.toUpperCase()), false);
});

test('hashes bytes exactly rather than normalizing text', async () => {
  assert.notEqual(
    await sha256Hex(new TextEncoder().encode('e\u0301')),
    await sha256Hex(new TextEncoder().encode('\u00e9')),
  );
});

test('matches the shared ingest-v1 signing vector', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../test-vectors/ingest-v1.json', import.meta.url),
      'utf8',
    ),
  ) as {
    body: string;
    body_hash: string;
    canonical: string;
    nonce: string;
    secret: string;
    signature: string;
    timestamp: string;
  };

  assert.equal(
    await sha256Hex(new TextEncoder().encode(vector.body)),
    vector.body_hash,
  );
  assert.equal(
    canonicalRequest(vector.timestamp, vector.nonce, vector.body_hash),
    vector.canonical,
  );
  assert.equal(await hmacHex(vector.secret, vector.canonical), vector.signature);
});

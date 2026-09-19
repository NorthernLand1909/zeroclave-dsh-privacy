import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearAccessKeyCacheForTests,
  verifyCloudflareAccess,
} from '../src/access.ts';

const NOW = new Date('2026-09-18T10:00:00.000Z');
const ISSUER = 'https://zeroclave.cloudflareaccess.com';

test('verifies an Access RS256 assertion against the team JWK endpoint', async () => {
  clearAccessKeyCacheForTests();
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: 'test-key',
  };
  const assertion = await makeJwt(pair.privateKey, {
    aud: ['admin-audience'],
    email: 'operator@example.test',
    exp: Math.floor(NOW.getTime() / 1000) + 300,
    iss: ISSUER,
    sub: 'operator-id',
  });
  let fetchCount = 0;
  const fetcher: typeof fetch = async (input) => {
    fetchCount += 1;
    assert.equal(String(input), `${ISSUER}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };

  const identity = await verifyCloudflareAccess(
    assertion,
    { audience: 'admin-audience', teamDomain: ISSUER },
    NOW,
    fetcher,
  );
  assert.deepEqual(identity, {
    subject: 'operator-id',
    email: 'operator@example.test',
  });

  await verifyCloudflareAccess(
    assertion,
    { audience: 'admin-audience', teamDomain: ISSUER },
    NOW,
    fetcher,
  );
  assert.equal(fetchCount, 1, 'JWKs are cached briefly');
});

test('rejects wrong audience, expired tokens, and modified signatures', async () => {
  clearAccessKeyCacheForTests();
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: 'test-key-2',
  };
  const fetcher: typeof fetch = async () => Response.json({ keys: [jwk] });
  const baseClaims = {
    aud: ['admin-audience'],
    exp: Math.floor(NOW.getTime() / 1000) + 300,
    iss: ISSUER,
    sub: 'operator-id',
  };
  const valid = await makeJwt(pair.privateKey, baseClaims, 'test-key-2');
  const expired = await makeJwt(
    pair.privateKey,
    { ...baseClaims, exp: Math.floor(NOW.getTime() / 1000) - 1 },
    'test-key-2',
  );

  assert.equal(
    await verifyCloudflareAccess(
      valid,
      { audience: 'wrong', teamDomain: ISSUER },
      NOW,
      fetcher,
    ),
    null,
  );
  assert.equal(
    await verifyCloudflareAccess(
      expired,
      { audience: 'admin-audience', teamDomain: ISSUER },
      NOW,
      fetcher,
    ),
    null,
  );
  const [header, payload, signature] = valid.split('.');
  assert.ok(header && payload && signature);
  const changedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(
    await verifyCloudflareAccess(
      `${header}.${payload}.${changedSignature}`,
      { audience: 'admin-audience', teamDomain: ISSUER },
      NOW,
      fetcher,
    ),
    null,
  );
});

async function makeJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  kid = 'test-key',
): Promise<string> {
  const header = encodeJson({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = encodeJson(claims);
  const signed = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${encodeBytes(new Uint8Array(signature))}`;
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

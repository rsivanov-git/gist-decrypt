import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { config, decrypt, createApp } from '../src/server.mjs';
const key = randomBytes(32);
const aad = Buffer.from('custom-context/тест/v2');
function encrypt(plain, aad = 'custom-context/тест/v2') {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'AES-256-GCM', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
test('compatible envelope; empty and binary content; rejects tampering, key and AAD mismatch', () => {
  for (const plain of [Buffer.alloc(0), Buffer.from('Привет\r\n'), randomBytes(1024)]) assert.deepEqual(decrypt(encrypt(plain), key, aad), plain);
  const encoded = encrypt(Buffer.from('private'));
  assert.throws(() => decrypt(encoded, randomBytes(32), aad));
  assert.throws(() => decrypt(encrypt(Buffer.from('private'), 'wrong'), key, aad));
  for (const field of ['nonce', 'tag', 'data']) {
    const e = JSON.parse(encoded), b = Buffer.from(e[field], 'base64'); b[0] ^= 1; e[field] = b.toString('base64');
    assert.throws(() => decrypt(JSON.stringify(e), key, aad));
  }
  assert.throws(() => decrypt('{}', key, aad));
});
test('configuration validation never exposes input secrets', () => {
  const env = { GIST_URL: 'https://gist.githubusercontent.com/user/abcdef/raw/Proxy-List.txt', PROXY_ENCRYPTION_KEY: key.toString('base64'), AAD: aad.toString('utf8') };
  assert.deepEqual(config(env).key, key);
  assert.deepEqual(config(env).aad, aad);
  assert.throws(() => config({ ...env, AAD: undefined }), /AAD must be set/);
  assert.deepEqual(config({ ...env, AAD: '' }).aad, Buffer.alloc(0));
  assert.deepEqual(decrypt(encrypt(Buffer.from('empty AAD'), ''), key, Buffer.alloc(0)), Buffer.from('empty AAD'));
  for (const url of ['http://localhost/file', 'https://example.com/file', env.GIST_URL + '?token=secret', 'https://gist.githubusercontent.com/user/abcdef/raw/revision/Proxy-List.txt']) assert.throws(() => config({ ...env, GIST_URL: url }));
  assert.throws(() => config({ ...env, PROXY_ENCRYPTION_KEY: 'password' }));
});
async function serve(t, fetchImpl, timeoutMs) {
  const app = createApp({ url: 'https://gist.githubusercontent.com/user/abcdef/raw/Proxy-List.txt', key, aad }, { fetchImpl, timeoutMs });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}
test('each request fetches fresh data; no cache or conditional 304; health and routing', async t => {
  let calls = 0;
  const url = await serve(t, async (_, options) => {
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    return new Response(encrypt(Buffer.from(`version ${++calls}`)));
  });
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(url + (i === 1 ? '/' : '/Proxy-List.txt'), { headers: { 'If-None-Match': '*' } });
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), `version ${i}`);
  }
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/missing')).status, 404);
  assert.equal((await fetch(url + '/Proxy-List.txt', { method: 'POST' })).status, 405);
  assert.equal(calls, 2);
});
test('upstream and authentication errors fail closed without old plaintext', async t => {
  const variants = [() => new Response('secret', { status: 404 }), () => new Response('bad JSON'), () => new Response(encrypt(Buffer.from('private'), 'wrong')), () => new Response('x'.repeat(1024 * 1024 + 1)), () => { throw new Error('secret URL'); }];
  let current = () => new Response(encrypt(Buffer.from('private')));
  const url = await serve(t, async () => current());
  assert.equal(await (await fetch(url + '/Proxy-List.txt')).text(), 'private');
  for (const variant of variants) {
    current = variant; const res = await fetch(url + '/Proxy-List.txt');
    assert.equal(res.status, 502); assert.equal(await res.text(), 'Unable to retrieve or decrypt the upstream file\n');
  }
});
test('upstream timeout returns error', async t => {
  const url = await serve(t, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 20);
  assert.equal((await fetch(url + '/Proxy-List.txt')).status, 502);
});

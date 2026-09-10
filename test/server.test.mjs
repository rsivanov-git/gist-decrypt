import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { config, decrypt, createApp } from '../src/server.mjs';
const password = 'test-пароль 🔑';
const key = createHash('md5').update(password, 'utf8').digest();
function encrypt(plain) {
  const iv = randomBytes(16), cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(plain), cipher.final()]).toString('base64');
}
test('Clash Mi format preserves UTF-8 bytes and accepts wrapped Base64', () => {
  for (const text of ['Привет\r\n', 'a'.repeat(16), '\uFEFFproxies: []\n', '🙂'.repeat(100)]) {
    const plain = Buffer.from(text), encoded = encrypt(plain);
    assert.deepEqual(decrypt(encoded, key), plain);
    assert.deepEqual(decrypt(' \r\n' + encoded.match(/.{1,20}/g).join('\r\n') + '\n', key), plain);
    assert.deepEqual(decrypt(encoded.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'), key), plain);
  }
});
test('rejects malformed input, empty plaintext, invalid UTF-8 and invalid padding', () => {
  for (const encoded of ['{}', '!!!!', 'A', 'AAAA=', '', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64'), encrypt(Buffer.alloc(0)), encrypt(Buffer.from([0xff]))]) {
    assert.throws(() => decrypt(encoded, key));
  }
  const raw = Buffer.from(encrypt(Buffer.from('private')), 'base64');
  raw[15] ^= 9; // Deterministically makes the last padding byte zero.
  assert.throws(() => decrypt(raw.toString('base64'), key));
});
test('configuration derives raw MD5 from exact password and never exposes secrets', () => {
  const env = { GIST_URL: 'https://gist.githubusercontent.com/user/abcdef/raw/Proxy-List.txt', DECRYPT_PASSWORD: password };
  assert.deepEqual(config(env).key, key);
  assert.deepEqual(config({ ...env, DECRYPT_PASSWORD: ' password ' }).key, createHash('md5').update(' password ').digest());
  for (const DECRYPT_PASSWORD of [undefined, '', 123]) assert.throws(() => config({ ...env, DECRYPT_PASSWORD }), /DECRYPT_PASSWORD must be a non-empty string/);
  for (const url of ['http://localhost/file', 'https://example.com/file', env.GIST_URL + '?token=secret', 'https://gist.githubusercontent.com/user/abcdef/raw/revision/Proxy-List.txt']) assert.throws(() => config({ ...env, GIST_URL: url }));
});
async function serve(t, fetchImpl, timeoutMs) {
  const app = createApp({ url: 'https://gist.githubusercontent.com/user/abcdef/raw/Proxy-List.txt', key }, { fetchImpl, timeoutMs });
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
    const res = await fetch(url + '/', { headers: { 'If-None-Match': '*' } });
    assert.equal(res.headers.get('content-disposition'), null);
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), `version ${i}`);
  }
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/missing')).status, 404);
  assert.equal((await fetch(url + '/', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/Proxy-List.txt')).status, 404);
  assert.equal(calls, 2);
});
test('upstream and decryption errors fail closed without old plaintext', async t => {
  const variants = [() => new Response('secret', { status: 404 }), () => new Response('bad JSON'), () => new Response(encrypt(Buffer.from([0xff]))), () => new Response('x'.repeat(1024 * 1024 + 1)), () => { throw new Error('secret URL'); }];
  let current = () => new Response(encrypt(Buffer.from('private')));
  const url = await serve(t, async () => current());
  assert.equal(await (await fetch(url + '/')).text(), 'private');
  for (const variant of variants) {
    current = variant; const res = await fetch(url + '/');
    assert.equal(res.status, 502); assert.equal(await res.text(), 'Unable to retrieve or decrypt the upstream file\n');
  }
});
test('upstream timeout returns error', async t => {
  const url = await serve(t, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 20);
  assert.equal((await fetch(url + '/')).status, 502);
});

test('independent OpenSSL AES-128-CBC fixture', () => {
  // openssl enc -aes-128-cbc, MD5("password"), IV 000102...0f, plaintext proxies: []\n
  const raw = Buffer.concat([Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), Buffer.from('+kMtC68Asx60wNJz5WKHMQ==', 'base64')]);
  const fixtureKey = createHash('md5').update('password').digest();
  assert.equal(decrypt(raw.toString('base64'), fixtureKey).toString(), 'proxies: []\n');
  assert.throws(() => decrypt(raw.toString('base64'), key));
});

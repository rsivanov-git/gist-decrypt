import { createDecipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
function base64(value) {
  if (typeof value !== 'string') throw new Error('Invalid Base64');
  // Dart Base64Codec accepts URL-safe characters and omitted padding too.
  const normalized = value.trim().replace(/[\r\n]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 ||
      (normalized.includes('=') && normalized.length % 4 !== 0)) throw new Error('Invalid Base64');
  return Buffer.from(normalized, 'base64');
}
export function config(env = process.env) {
  let url, key;
  try {
    url = new URL(env.GIST_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[^/]+\/[a-f0-9]+\/raw\/[^/]+$/.test(url.pathname)) throw new Error();
  } catch { throw new Error('GIST_URL must be an HTTPS gist.githubusercontent.com raw file URL without a revision, query or credentials.'); }
  if (typeof env.DECRYPT_PASSWORD !== 'string' || env.DECRYPT_PASSWORD.length === 0) throw new Error('DECRYPT_PASSWORD must be a non-empty string.');
  key = createHash('md5').update(env.DECRYPT_PASSWORD, 'utf8').digest();
  return { url: url.href, key };
}
export function decrypt(text, key) {
  const raw = base64(text);
  if (raw.length <= 16 || (raw.length - 16) % 16 !== 0) throw new Error('Invalid encrypted profile');
  const decipher = createDecipheriv('aes-128-cbc', key, raw.subarray(0, 16));
  // Buffer the entire message until padding and UTF-8 validation succeed.
  // CBC has no authentication tag: these checks cannot detect all alterations.
  const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
  if (plain.length === 0) throw new Error('Empty profile');
  new TextDecoder('utf-8', { fatal: true }).decode(plain);
  return plain;
}
export function createApp(settings, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body);
    };
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); reply(405, 'Method not allowed\n'); return; }
    if (req.url === '/healthz') { reply(200, 'ok\n'); return; }
    if (req.url !== '/') { reply(404, 'Not found\n'); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const upstream = await fetchImpl(settings.url, {
        redirect: 'error', cache: 'no-store', signal,
        headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      });
      if (upstream.status !== 200 || !upstream.body) throw new Error('Upstream failure');
      const chunks = []; let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Upstream too large');
        chunks.push(chunk);
      }
      const plain = decrypt(Buffer.concat(chunks).toString('utf8'), settings.key);
      if (!res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': plain.length });
        res.end(plain);
      }
    } catch {
      controller.abort();
      if (!res.destroyed) reply(502, 'Unable to retrieve or decrypt the upstream file\n');
    } finally { res.off('close', disconnect); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createApp(config());
    server.listen(8080, '0.0.0.0', () => console.log('gist-decrypt listening on port 8080'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

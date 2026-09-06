import { createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
function base64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid Base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid Base64');
  return bytes;
}
export function config(env = process.env) {
  let url, key;
  try {
    url = new URL(env.GIST_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[^/]+\/[a-f0-9]+\/raw\/[^/]+$/.test(url.pathname)) throw new Error();
  } catch { throw new Error('GIST_URL must be an HTTPS gist.githubusercontent.com raw file URL without a revision, query or credentials.'); }
  try { key = base64(env.PROXY_ENCRYPTION_KEY); if (key.length !== 32) throw new Error(); }
  catch { throw new Error('PROXY_ENCRYPTION_KEY must contain a Base64-encoded 32-byte key.'); }
  if (typeof env.AAD !== 'string') throw new Error('AAD must be set explicitly (an empty string is allowed).');
  return { url: url.href, key, aad: Buffer.from(env.AAD, 'utf8') };
}
export function decrypt(text, key, aad) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || data.algorithm !== 'AES-256-GCM') throw new Error('Unsupported envelope');
  const nonce = base64(data.nonce), tag = base64(data.tag), ciphertext = base64(data.data);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // Never send update() output before final() authenticates the entire message.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
        headers: { Accept: 'application/json, text/plain', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      });
      if (upstream.status !== 200 || !upstream.body) throw new Error('Upstream failure');
      const chunks = []; let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Upstream too large');
        chunks.push(chunk);
      }
      const plain = decrypt(Buffer.concat(chunks).toString('utf8'), settings.key, settings.aad);
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

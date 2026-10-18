/**
 * A stand-in for the Python model service (the HTTP contract of section 4.1), small enough to read:
 *
 *   GET  /health        {ok, service, sam, ...}; needs the key header when a key is set (else 401)
 *   GET  /sam/health    the SAM contract body
 *   POST /segment       answers with a description of what it received (size, sha256, a few headers)
 *   POST /sam/segment   echoes the request body back, streaming (big bodies in both directions)
 *   POST /sam/refine    {"hang":true} never answers; {"status":422} answers that status; {"cut":true} dies mid-answer
 *
 * It records every request in `calls`, and which hanging requests were abandoned by the caller in `abandoned`.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export const SAM_STATE = { enabled: true, status: 'ready', error: '', backend: 'sam2', model: 'sam2.1-test', interactive: true, textPrompts: false };

/**
 * @param {{key?: string, sam?: object, healthDelayMs?: number}} [options]
 */
export async function startFakeModelService({ key = '', sam = SAM_STATE, healthDelayMs = 0 } = {}) {
  const calls = [];
  const abandoned = [];
  const reply = (res, status, body) => {
    const raw = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) });
    res.end(raw);
  };
  const error = (res, status, apiStatus, message) => reply(res, status, { error: { code: status, status: apiStatus, message } });

  const server = http.createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (key && req.headers['x-terucon-model-key'] !== key) return error(res, 401, 'UNAUTHENTICATED', 'The model service needs its key.');
    if (req.method === 'GET' && req.url === '/health') {
      if (healthDelayMs) await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
      return reply(res, 200, { ok: true, service: 'terucon-model', version: 'test', google: { configured: false, mode: 'none', error: '' }, sam, segmentation: { engine: 'auto' } });
    }
    if (req.method === 'GET' && req.url === '/sam/health') {
      return reply(res, 200, { status: 'ok', model: sam.model, backend: sam.backend, device: 'cpu', interactive: sam.interactive, text_prompts: sam.textPrompts, error: '' });
    }
    if (req.method === 'POST' && req.url === '/sam/segment') {
      res.writeHead(200, { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' });
      req.pipe(res); // the answer starts while the request is still arriving
      return;
    }
    if (req.method === 'POST' && req.url === '/segment') {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of req) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      return reply(res, 200, {
        ok: true,
        bytes,
        sha256: hash.digest('hex'),
        contentType: req.headers['content-type'],
        host: req.headers.host,
        forwarded: Object.keys(req.headers).filter((h) => ['origin', 'cookie', 'authorization', 'x-api-key', 'referer'].includes(h)),
      });
    }
    if (req.method === 'POST' && req.url === '/sam/refine') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (command.hang) {
        res.on('close', () => abandoned.push(req.url));
        return; // never answer
      }
      if (command.cut) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"mask":"abc');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (command.status) return error(res, command.status, 'FAILED_PRECONDITION', 'SAM found nothing at that point.');
      return reply(res, 200, { mask: 'png', image_id: 'img-1', score: 0.9, model: sam.model });
    }
    return error(res, 404, 'NOT_FOUND', 'No such route.');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    abandoned,
    server,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

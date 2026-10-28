/**
 * A stand-in for one Modal GPU pool: answers GET /healthz after `bootMs` (the cold start), with the bearer key checked, and
 * records every request. Tests point the studio's ONEFORMER_URL / ANALYZE_URL / ... at it, so nothing real is ever called.
 */
import http from 'node:http';

/**
 * @param {{key?: string, bootMs?: number}} [options]
 * @returns {Promise<{url: string, origin: string, hits: Array<{method: string, path: string, authorized: boolean}>, close: () => Promise<void>}>}
 */
export async function startMockModal({ key = 'test-key', bootMs = 0 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${key}`;
    hits.push({ method: req.method, path: req.url, authorized });
    const answer = () => {
      if (!authorized) return res.writeHead(401).end();
      if (req.url === '/healthz') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return res.writeHead(404).end();
    };
    if (bootMs > 0) setTimeout(answer, bootMs);
    else answer();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin,
    origin,
    hits,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

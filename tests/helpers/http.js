/**
 * A raw HTTP client for the tests. fetch() is not used on purpose: WHATWG URL parsing rewrites "/media/../.env"
 * to "/.env" and does not let a test choose the Host header, so it can not test traversal or the Host guard.
 */
import http from 'node:http';
import net from 'node:net';

/**
 * @param {number} port
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.path] sent exactly as given
 * @param {Record<string, string>} [options.headers] `Host` defaults to localhost:<port>
 * @param {string | Buffer | object} [options.body] an object is sent as JSON (with the JSON content type unless headers say otherwise)
 */
export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const sendHeaders = { Host: `localhost:${port}`, ...headers };
  let payload = body;
  if (body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    if (!Object.keys(sendHeaders).some((k) => k.toLowerCase() === 'content-type')) sendHeaders['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sendHeaders, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text: buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8')),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Poll until `check()` returns something truthy; fail after `timeoutMs`. */
export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 25, what = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Send literal bytes over a socket and return what comes back (until the server closes or `settleMs` of silence).
 * For requests a polite client would never make: a body that is announced but never sent, odd Host headers.
 */
export function rawRequest(port, text, { settleMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    const chunks = [];
    let timer = setTimeout(() => socket.end(), settleMs);
    socket.on('data', (c) => {
      chunks.push(c);
      clearTimeout(timer);
      timer = setTimeout(() => socket.end(), settleMs);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const [head, ...rest] = raw.split('\r\n\r\n');
      resolve({ raw, status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1]), head, body: rest.join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

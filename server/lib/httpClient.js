/**
 * A small outbound HTTP(S) client with the timeout semantics the Google calls need.
 *
 * fetch() cannot tell "could not connect" from "connected but no answer", and its defaults wait
 * 300 seconds for headers. Here the two are separate: `connectTimeoutMs` covers DNS, TCP and the TLS
 * handshake; `readTimeoutMs` is the longest silence allowed once the request has been sent (it restarts
 * with every chunk of the answer, like Python requests' read timeout). Every call uses a fresh
 * connection, so a connect timer can never be fooled by a reused socket.
 */
import http from 'node:http';
import https from 'node:https';

const agents = {
  'http:': new http.Agent({ keepAlive: false }),
  'https:': new https.Agent({ keepAlive: false }),
};

/** The server accepted nothing (phase "connect") or went quiet after the request was sent (phase "read"). */
export class RequestTimeoutError extends Error {
  constructor(phase) {
    super(`${phase} timeout`);
    this.name = 'RequestTimeoutError';
    this.phase = phase;
  }
}

/** The connection failed, was refused or was cut. `code` is the system error code when there is one. */
export class RequestNetworkError extends Error {
  constructor(cause) {
    super(cause.message);
    this.name = 'RequestNetworkError';
    this.code = cause.code;
    this.cause = cause;
  }
}

export class HttpResponse {
  constructor(status, headers, body) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  text() {
    return this.body.toString('utf8');
  }

  /** The parsed JSON body, or undefined when it is not JSON. */
  json() {
    try {
      return JSON.parse(this.text());
    } catch {
      return undefined;
    }
  }
}

/** Calls `done` once the request's socket is connected (TLS handshake included), or at once if it already was. */
export function whenConnected(req, secure, done) {
  req.on('socket', (socket) => {
    if (socket.connecting) socket.once(secure ? 'secureConnect' : 'connect', done);
    else done();
  });
}

/**
 * @param {string | URL} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string | Buffer} [options.body]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.readTimeoutMs]
 * @param {Function} [options.lookup] custom DNS lookup (tests use it to make a connect slow)
 * @returns {Promise<HttpResponse>} rejects with RequestTimeoutError or RequestNetworkError
 */
export function httpRequest(url, { method = 'GET', headers = {}, body, connectTimeoutMs = 10_000, readTimeoutMs = 240_000, lookup } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    let connectTimer = null;
    let readTimer = null;
    let settled = false;
    let req = null;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      settle(value);
    };
    const fail = (err) => {
      finish(reject, err);
      req?.destroy();
    };
    const armRead = () => {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => fail(new RequestTimeoutError('read')), readTimeoutMs);
    };

    const sendHeaders = { ...headers };
    if (body !== undefined) sendHeaders['Content-Length'] = Buffer.byteLength(body);
    req = (secure ? https : http).request(target, { method, headers: sendHeaders, agent: agents[target.protocol], lookup }, (res) => {
      const chunks = [];
      armRead();
      res.on('data', (chunk) => {
        chunks.push(chunk);
        armRead();
      });
      res.on('end', () => finish(resolve, new HttpResponse(res.statusCode, res.headers, Buffer.concat(chunks))));
      res.on('error', (err) => fail(new RequestNetworkError(err)));
      res.on('close', () => {
        if (!res.complete) fail(new RequestNetworkError(Object.assign(new Error('The connection was closed before the answer was complete.'), { code: 'ECONNRESET' })));
      });
    });
    connectTimer = setTimeout(() => fail(new RequestTimeoutError('connect')), connectTimeoutMs);
    whenConnected(req, secure, () => clearTimeout(connectTimer));
    req.on('error', (err) => fail(new RequestNetworkError(err)));
    req.on('finish', armRead);
    req.end(body);
  });
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { after, describe } from 'node:test';

// TeruBot's real Gemini connection (the studio's swatchroom/server/google/vertex.js) against a MOCK Vertex and a MOCK token endpoint on this
// machine. This file sets the studio's test overrides in the environment BEFORE anything loads that module (it reads the environment once),
// and nothing here can reach Google. Keep it in its own file: the settings are per process.

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mock = { tokens: 0, calls: [], handler: null, server: null };

// top level, in this order: the mock first, the environment next, only then the first import that can load the studio's Google module
mock.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/token') {
        mock.tokens += 1;
        res.setHeader('Content-Type', 'application/json');
        if (mock.tokenFails) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
        }
        return res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }));
      }
      const model = /models\/([^:/]+):generateContent/.exec(req.url)?.[1];
      const entry = { url: req.url, model, auth: req.headers.authorization, body: JSON.parse(text) };
      mock.calls.push(entry);
      mock.handler(entry, res, mock.calls.length);
    });
  });
await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
{
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account', project_id: 'mock-project', client_email: 'bot@mock-project.iam.example', private_key: privateKey, private_key_id: 'k1', token_uri: `${base}/token` });
  process.env.GOOGLE_CLOUD_PROJECT = 'mock-project';
  process.env.VERTEX_LOCATION = 'global';
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
  process.env.VERTEX_BASE_URL = base;
}

after(() => new Promise((resolve) => (mock.server.listening ? mock.server.close(resolve) : resolve())));

const { startBotApp } = await import('../helpers/terubotApp.js');
const { PROJECT_ROOT } = await import('../helpers/tempRoot.js');
const { TEXT_MODEL_CHAIN } = (await import('node:module')).createRequire(import.meta.url)(`${PROJECT_ROOT}/swatchroom/server/google/vertex.js`);

const answer = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 3 }, ...extra });
const send = (res, body, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const startReal = (options = {}) => startBotApp({ terubot: { gemini: undefined, googleDir: `${PROJECT_ROOT}/swatchroom` }, ...options });
const reset = (handler) => {
  mock.calls.length = 0;
  mock.tokens = 0;
  mock.tokenFails = false;
  mock.handler = handler;
};

describe('the real connection, with a mock Vertex', () => {
  test('the token endpoint rejects the key: aiOn false, and nothing of Google\'s words reaches the visitor (first, before any token is cached)', async () => {
    reset((entry, res) => send(res, answer([{ text: 'never' }])));
    mock.tokenFails = true;
    const app = await startReal();
    try {
      const r = await app.say('hi');
      assert.equal(r.status, 200);
      assert.equal(r.json().aiOn, false);
      assert.ok(!/JWT|signature|invalid_grant/i.test(r.text));
      assert.equal(mock.calls.length, 0);
      assert.ok(app.log.lines.some((l) => /kind=unavailable/.test(l) && /Google rejected the key signature/.test(l)));
    } finally {
      mock.tokenFails = false;
      await app.stop();
    }
  });

  test('a whole turn: the request Vertex gets, the tool round, the answer; and /status calls nobody', async () => {
    const functionCallPart = { functionCall: { id: 'fc-1', name: 'search_materials', args: { query: 'bronze', limit: 1 } }, thoughtSignature: 'SIG-ABC' };
    reset((entry, res, n) => send(res, n === 1 ? answer([functionCallPart]) : answer([{ text: 'Brushed Bronze is the one.' }])));
    const app = await startReal();
    try {
      assert.deepEqual((await app.status()).json(), { aiOn: true, model: TEXT_MODEL_CHAIN[0], signedIn: false, voice: true });
      assert.equal(mock.calls.length, 0, 'the status route did not call Gemini');
      assert.equal(mock.tokens, 0, 'nor did it ask for a token');

      const r = await app.say('bronze acp?');
      assert.equal(r.status, 200);
      const body = r.json();
      assert.equal(body.aiOn, true);
      assert.equal(body.reply, 'Brushed Bronze is the one.');
      assert.equal(body.model, TEXT_MODEL_CHAIN[0]);
      assert.equal(body.cards.length, 1);
      assert.equal(mock.calls.length, 2);

      const [first, second] = mock.calls;
      assert.equal(first.auth, 'Bearer mock-token');
      assert.equal(first.model, TEXT_MODEL_CHAIN[0]);
      assert.match(first.url, /^\/v1\/projects\/mock-project\/locations\/global\/publishers\/google\/models\//);
      // what reaches Vertex is what TeruBot built, unchanged
      assert.match(first.body.systemInstruction.parts[0].text, /You are TeruBot/);
      assert.deepEqual(first.body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
      const toolNames = first.body.tools[0].functionDeclarations.map((t) => t.name);
      assert.ok(toolNames.includes('search_materials') && toolNames.includes('cart_add') && !toolNames.includes('get_account_summary'));
      assert.deepEqual(first.body.generationConfig, { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'LOW' } });
      assert.deepEqual(first.body.contents, [{ role: 'user', parts: [{ text: 'bronze acp?' }] }]);
      // the second request carries the model's own turn untouched (with its signature) and the tool result
      assert.deepEqual(second.body.contents[1], { role: 'model', parts: [functionCallPart] });
      assert.equal(second.body.contents[2].role, 'user');
      assert.equal(second.body.contents[2].parts[0].functionResponse.name, 'search_materials');
      assert.equal(second.body.contents[2].parts[0].functionResponse.id, 'fc-1');
      assert.equal(mock.tokens, 1, 'one token served both calls');
      // the log has the facts and none of the words
      const line = app.log.lines.find((l) => /chat ok/.test(l));
      assert.match(line, /model=.*rounds=1.*tools=search_materials.*tokens=\d+\/\d+\+\d+/);
      assert.ok(!app.log.lines.join('\n').includes('bronze acp'));
    } finally {
      await app.stop();
    }
  });

  test('a 400 on the first request body falls to the next one WITH the tools and the system instruction; a 404 falls to the next model', async () => {
    reset((entry, res, n) => {
      if (n === 1) return send(res, { error: { status: 'INVALID_ARGUMENT', message: 'thinking_level is not supported' } }, 400);
      if (n === 2) return send(res, { error: { status: 'NOT_FOUND', message: 'model not found' } }, 404);
      return send(res, answer([{ text: 'Fine.' }]));
    });
    const app = await startReal();
    try {
      const r = await app.say('hi');
      assert.equal(r.status, 200);
      assert.equal(mock.calls.length, 3);
      const [thinking, plain, nextModel] = mock.calls;
      assert.ok(thinking.body.generationConfig.thinkingConfig);
      assert.ok(!plain.body.generationConfig.thinkingConfig, 'the simpler body has no thinking setting');
      assert.equal(plain.model, thinking.model);
      for (const entry of [plain, nextModel]) {
        assert.ok(entry.body.systemInstruction && entry.body.tools?.[0]?.functionDeclarations?.length > 5 && entry.body.toolConfig, 'the fallback keeps the system instruction, the tools and the tool mode');
      }
      assert.equal(nextModel.model, TEXT_MODEL_CHAIN[1]);
      assert.equal(r.json().model, TEXT_MODEL_CHAIN[1]);
    } finally {
      await app.stop();
    }
  });

  test('a temporary error is retried; the answer comes', async () => {
    reset((entry, res, n) => (n === 1 ? send(res, { error: { status: 'UNAVAILABLE', message: 'try again' } }, 503) : send(res, answer([{ text: 'Back.' }]))));
    const app = await startReal();
    try {
      const r = await app.say('hi');
      assert.equal(r.status, 200);
      assert.equal(r.json().reply, 'Back.');
      assert.equal(mock.calls.length, 2);
    } finally {
      await app.stop();
    }
  });

  test('Google refuses the key or the permission: aiOn false for the visitor, the reason only in the log', async () => {
    reset((entry, res) => send(res, { error: { status: 'PERMISSION_DENIED', message: 'Permission denied on project mock-project' } }, 403));
    const app = await startReal();
    try {
      const r = await app.say('hi');
      assert.equal(r.status, 200);
      assert.equal(r.json().aiOn, false);
      assert.ok(!/mock-project|Permission|Grant/.test(r.text));
      assert.ok(app.log.lines.some((l) => /kind=unavailable status=403/.test(l)));
    } finally {
      await app.stop();
    }
  });

  test('a model that never answers: the deadline ends it with a 502 and the request to Google is dropped', async () => {
    let dropped = false;
    reset((entry, res) => {
      res.on('close', () => { dropped = true; });
    });
    const app = await startReal({ env: 'TERUBOT_TIMEOUT_SECONDS=1\n' });
    try {
      const t0 = Date.now();
      const r = await app.say('hi');
      assert.equal(r.status, 502);
      assert.ok(Date.now() - t0 < 4000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(dropped, true, 'the request to Vertex was aborted');
    } finally {
      await app.stop();
    }
  });

  test('an answer with nothing in it, or cut at the token limit, still gives the visitor a sentence', async () => {
    reset((entry, res, n) => send(res, n === 1 ? { candidates: [{ finishReason: 'MAX_TOKENS' }] } : { candidates: [{ content: { role: 'model', parts: [{ text: 'Partial answer that was cut' }] }, finishReason: 'MAX_TOKENS' }] }));
    const app = await startReal();
    try {
      const empty = await app.say('hi');
      assert.equal(empty.status, 200);
      assert.match(empty.json().reply, /ask it another way/);
      assert.equal((await app.say('again')).json().reply, 'Partial answer that was cut');
    } finally {
      await app.stop();
    }
  });

  test('Vertex unreachable: aiOn false (last, because it stops the mock)', async () => {
    reset(() => {});
    await new Promise((resolve) => mock.server.close(resolve));
    mock.server.closeAllConnections?.();
    const app = await startReal();
    try {
      const r = await app.say('hi');
      assert.equal(r.status, 200);
      assert.equal(r.json().aiOn, false);
      assert.match(r.json().reply, /can't be reached/);
    } finally {
      await app.stop();
    }
  });
});

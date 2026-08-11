const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ENV_KEYS = [
  'SESSION_SECRET',
  'CLAUDE_API_KEY',
  'UPSTREAM_MESSAGES_URL',
  'UPSTREAM_API_KEY',
  'UPSTREAM_AUTH_HEADER',
  'UPSTREAM_ANTHROPIC_VERSION',
  'STORE_FILE',
  'DATA_DIR',
  'PORT'
];

const ORIGINAL_ENV = { ...process.env };

function resetEnv(overrides = {}) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
}

function loadApp() {
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/app')];
  return require('../src/app');
}

function createTempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude2api-test-'));
  return path.join(dir, 'store.json');
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

test('proxies non-stream requests to configured upstream backend', async () => {
  const captured = {};
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured.headers = req.headers;
      captured.body = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcompl_test',
        type: 'message',
        role: 'assistant',
        model: captured.body.model,
        content: [{ type: 'text', text: 'real backend ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 }
      }));
    });
  });
  const upstreamPort = await listen(upstream);

  const storeFile = createTempStoreFile();
  resetEnv({
    SESSION_SECRET: 'test-secret',
    CLAUDE_API_KEY: 'local-key',
    UPSTREAM_MESSAGES_URL: `http://127.0.0.1:${upstreamPort}/v1/messages`,
    UPSTREAM_API_KEY: 'upstream-key',
    UPSTREAM_AUTH_HEADER: 'x-api-key',
    STORE_FILE: storeFile
  });

  const { startServer } = loadApp();
  const appServer = startServer(0);
  await new Promise((resolve) => appServer.once('listening', resolve));
  const appPort = appServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'local-key'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: '你好' }]
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.content[0].text, 'real backend ok');
    assert.equal(captured.headers['x-api-key'], 'upstream-key');
    assert.equal(captured.body.model, 'claude-sonnet-5');

    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.equal(store.usageEvents.length, 1);
    assert.equal(store.usageEvents[0].success, true);
  } finally {
    await close(appServer);
    await close(upstream);
  }
});

test('passes through streaming responses and can forward bearer auth upstream', async () => {
  const captured = {};
  const upstream = http.createServer((req, res) => {
    captured.authorization = req.headers.authorization;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.write('event: message_start\n');
    res.write('data: {"type":"message_start"}\n\n');
    res.write('event: message_stop\n');
    res.write('data: {"type":"message_stop"}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);

  resetEnv({
    SESSION_SECRET: 'test-secret',
    CLAUDE_API_KEY: 'local-key',
    UPSTREAM_MESSAGES_URL: `http://127.0.0.1:${upstreamPort}/v1/messages`,
    UPSTREAM_AUTH_HEADER: 'authorization',
    STORE_FILE: createTempStoreFile()
  });

  const { startServer } = loadApp();
  const appServer = startServer(0);
  await new Promise((resolve) => appServer.once('listening', resolve));
  const appPort = appServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'local-key'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: '你好' }]
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /event: message_start/);
    assert.match(body, /event: message_stop/);
    assert.equal(captured.authorization, 'Bearer '.concat('local-key'));
  } finally {
    await close(appServer);
    await close(upstream);
  }
});

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readStore, withStoreLock } = require('./store');

const app = express();

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function toMillis(ts) {
  return new Date(ts).getTime();
}

function getTodayStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter((v) => v && typeof v === 'object');
  }
  if (content && typeof content === 'object' && content.type) {
    return [content];
  }
  return [];
}

function countInputImages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    const blocks = normalizeContent(msg?.content);
    for (const block of blocks) {
      if (block?.type === 'image' || block?.type === 'input_image') {
        total += 1;
      }
    }
  }
  return total;
}

function thinkingEnabled(body, routedModel) {
  const t = body?.thinking;
  if (t === true) return true;
  if (t && typeof t === 'object' && t.type === 'enabled') return true;
  return typeof routedModel === 'string' && routedModel.endsWith('-thinking');
}

function timingSafeStringEqual(a, b) {
  const leftRaw = Buffer.from(String(a || ''), 'utf8');
  const rightRaw = Buffer.from(String(b || ''), 'utf8');
  const len = Math.max(leftRaw.length, rightRaw.length, 1);
  const left = Buffer.alloc(len);
  const right = Buffer.alloc(len);
  leftRaw.copy(left);
  rightRaw.copy(right);
  return crypto.timingSafeEqual(left, right) && leftRaw.length === rightRaw.length;
}

function authRequired(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomUUID();
  }
  return req.session.csrfToken;
}

function csrfRequired(req, res, next) {
  const sent = req.headers['x-csrf-token'];
  const expected = req.session?.csrfToken;
  if (!sent || !expected || sent !== expected) {
    return res.status(403).json({ error: 'csrf_invalid' });
  }
  return next();
}

function apiKeyRequired(req, res, next) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return next();
  }

  const auth = req.headers.authorization || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerToken = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  const token = bearerToken || headerToken;
  if (!timingSafeStringEqual(token, apiKey)) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  return next();
}

function getUpstreamUrl() {
  const raw = process.env.UPSTREAM_MESSAGES_URL || '';
  return raw.trim();
}

function buildUpstreamHeaders(req, stream) {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json'
  };
  const configuredAuthHeader = (process.env.UPSTREAM_AUTH_HEADER || 'x-api-key').trim().toLowerCase();
  const configuredApiKey = (process.env.UPSTREAM_API_KEY || '').trim();
  const auth = req.headers.authorization || '';
  const inboundBearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const inboundApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  const inboundToken = inboundBearerToken || inboundApiKey;

  if (configuredApiKey) {
    headers[configuredAuthHeader] = configuredAuthHeader === 'authorization'
      ? 'Bearer ' + configuredApiKey
      : configuredApiKey;
  } else if (inboundToken) {
    headers[configuredAuthHeader] = configuredAuthHeader === 'authorization'
      ? 'Bearer ' + inboundToken
      : inboundToken;
  }

  const configuredVersion = (process.env.UPSTREAM_ANTHROPIC_VERSION || '').trim();
  const requestVersion = typeof req.headers['anthropic-version'] === 'string'
    ? req.headers['anthropic-version'].trim()
    : '';
  if (configuredVersion) {
    headers['anthropic-version'] = configuredVersion;
  } else if (requestVersion) {
    headers['anthropic-version'] = requestVersion;
  }

  const requestBeta = typeof req.headers['anthropic-beta'] === 'string'
    ? req.headers['anthropic-beta'].trim()
    : '';
  if (requestBeta) {
    headers['anthropic-beta'] = requestBeta;
  }

  return headers;
}

function copyUpstreamHeaders(upstream, res, stream) {
  const headerNames = stream
    ? ['content-type', 'cache-control', 'connection', 'x-request-id']
    : ['content-type', 'x-request-id'];
  for (const name of headerNames) {
    const value = upstream.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
}

async function proxyToUpstream(req, res, stream) {
  const upstreamUrl = getUpstreamUrl();
  const controller = new AbortController();
  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  req.on('aborted', () => controller.abort());

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(req, stream),
      body: JSON.stringify(req.body),
      signal: controller.signal
    });

    res.status(upstreamResponse.status);
    copyUpstreamHeaders(upstreamResponse, res, stream);

    if (!upstreamResponse.body) {
      return res.end();
    }

    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }
    return res.end();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function computeAccountStats(store) {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const todayStart = getTodayStart(new Date(now));

  return store.accounts.map((account) => {
    const all = store.usageEvents.filter((e) => e.accountId === account.id);
    const today = all.filter((e) => toMillis(e.timestamp) >= todayStart);
    const seven = all.filter((e) => toMillis(e.timestamp) >= sevenDaysAgo);

    const todayCount = today.length;
    const sevenCount = seven.length;
    const limit = Number(account.dailyLimit || 0);

    const dailyUsageRate = limit > 0 ? Number(((todayCount / limit) * 100).toFixed(2)) : null;
    const sevenDayUsageRate = limit > 0
      ? Number(((sevenCount / (limit * 7)) * 100).toFixed(2))
      : null;

    return {
      id: account.id,
      email: account.email,
      status: account.status,
      dailyLimit: limit,
      todaySessions: todayCount,
      sevenDaySessions: sevenCount,
      totalSessions: all.length,
      dailyUsageRate,
      sevenDayUsageRate
    };
  });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
if (!process.env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('SESSION_SECRET is not set; using an ephemeral random secret for this process.');
}
if (!process.env.CLAUDE_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('CLAUDE_API_KEY is not set; /v1/messages is unauthenticated.');
}
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.get('/health', async (req, res) => {
  const store = await readStore();
  res.json({ status: 'ok', accounts: store.accounts.length });
});

app.post('/v1/messages', apiKeyRequired, async (req, res) => {
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : null;
  const stream = Boolean(req.body?.stream);
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const requestTools = Array.isArray(req.body?.tools) ? req.body.tools : [];
  const imageCount = countInputImages(messages);
  const withThinking = thinkingEnabled(req.body, requestedModel || '');
  const upstreamUrl = getUpstreamUrl();
  let success = false;

  if (!upstreamUrl) {
    return res.status(503).json({
      error: 'upstream_not_configured',
      message: 'UPSTREAM_MESSAGES_URL is required for /v1/messages'
    });
  }

  try {
    await proxyToUpstream(req, res, stream);
    success = res.statusCode >= 200 && res.statusCode < 400;
    return;
  } catch (error) {
    success = false;
    if (error?.name === 'AbortError') {
      if (!res.headersSent) {
        return res.status(504).json({
          error: 'upstream_request_timeout',
          message: 'upstream request timed out'
        });
      }
      return;
    }
    return res.status(502).json({
      error: 'upstream_request_failed',
      message: error instanceof Error ? error.message : 'unknown_error'
    });
  } finally {
    await withStoreLock(async (store) => {
      store.usageEvents.push({
        accountId: null,
        requestedModel,
        routedModel: requestedModel,
        stream,
        hasTools: requestTools.length > 0,
        usedTool: false,
        hasImages: imageCount > 0,
        hasThinking: withThinking,
        timestamp: new Date().toISOString(),
        success
      });
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      store.usageEvents = store.usageEvents.filter((e) => toMillis(e.timestamp) >= cutoff);
    });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const store = await readStore();
  const hash = username === store.adminUser ? store.adminPassHash : DUMMY_HASH;
  const ok = bcrypt.compareSync(password || '', hash);

  if (username !== store.adminUser || !ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  req.session.isAdmin = true;
  req.session.adminUser = store.adminUser;
  ensureCsrfToken(req);
  return res.json({ ok: true, user: store.adminUser });
});

app.get('/api/admin/csrf', authRequired, (req, res) => {
  res.json({ token: ensureCsrfToken(req) });
});

app.post('/api/admin/logout', authRequired, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', authRequired, (req, res) => {
  res.json({ ok: true, user: req.session.adminUser });
});

app.post('/api/admin/password', authRequired, csrfRequired, async (req, res) => {
  const { newPassword } = req.body || {};

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'new_password_too_short' });
  }

  await withStoreLock(async (lockedStore) => {
    lockedStore.adminPassHash = bcrypt.hashSync(newPassword, 10);
  });
  return res.json({ ok: true });
});

app.get('/api/stats/accounts', authRequired, async (req, res) => {
  const store = await readStore();
  res.json({ items: computeAccountStats(store) });
});

// Account management
app.get('/api/admin/accounts', authRequired, async (req, res) => {
  const store = await readStore();
  const items = store.accounts.map((a) => ({
    id: a.id,
    email: a.email,
    status: a.status,
    dailyLimit: a.dailyLimit || 0
  }));
  res.json({ items });
});

app.post('/api/admin/accounts', authRequired, csrfRequired, async (req, res) => {
  const { email, sessionKey } = req.body || {};
  if (!sessionKey || typeof sessionKey !== 'string' || !sessionKey.trim()) {
    return res.status(400).json({ error: 'session_key_required' });
  }
  let newAccount;
  await withStoreLock(async (store) => {
    const id = `acc-${Date.now()}`;
    newAccount = {
      id,
      email: (email || '').trim() || `${id}@local`,
      sessionKey: sessionKey.trim(),
      dailyLimit: Number(process.env.CLAUDE_DAILY_LIMIT || 0),
      status: 'active'
    };
    store.accounts.push(newAccount);
  });
  return res.json({ ok: true, account: { id: newAccount.id, email: newAccount.email, status: newAccount.status } });
});

// NOTE: /bulk, /test-all must be registered BEFORE /:id to avoid Express matching them as an id param.

// Bulk import: each line is "sessionKey" or "email:sessionKey" or "email sessionKey"
app.post('/api/admin/accounts/bulk', authRequired, csrfRequired, async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text_required' });
  }
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const added = [];
  const skipped = [];
  await withStoreLock(async (store) => {
    for (const line of lines) {
      // Support: "email sessionKey", "email:sessionKey", or just "sessionKey"
      let email = '';
      let sessionKey = '';
      const spaceIdx = line.indexOf(' ');
      const colonIdx = line.indexOf(':');
      if (spaceIdx > 0 && !line.startsWith('sk-ant-')) {
        email = line.slice(0, spaceIdx).trim();
        sessionKey = line.slice(spaceIdx + 1).trim();
      } else if (colonIdx > 0 && !line.startsWith('sk-ant-')) {
        email = line.slice(0, colonIdx).trim();
        sessionKey = line.slice(colonIdx + 1).trim();
      } else {
        sessionKey = line;
      }
      if (!sessionKey) {
        skipped.push(line);
        continue;
      }
      // Skip duplicates by sessionKey
      if (store.accounts.some((a) => a.sessionKey === sessionKey)) {
        skipped.push(line);
        continue;
      }
      const id = `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const account = {
        id,
        email: email || `${id}@local`,
        sessionKey,
        dailyLimit: Number(process.env.CLAUDE_DAILY_LIMIT || 0),
        status: 'active'
      };
      store.accounts.push(account);
      added.push({ id: account.id, email: account.email });
    }
  });
  return res.json({ ok: true, added: added.length, skipped: skipped.length });
});

// Test all accounts: verify sessionKey format; mark obviously invalid ones as banned
app.post('/api/admin/accounts/test-all', authRequired, csrfRequired, async (req, res) => {
  const results = [];
  await withStoreLock(async (store) => {
    for (const account of store.accounts) {
      if (account.status === 'banned') {
        results.push({ id: account.id, email: account.email, result: 'skipped_banned' });
        continue;
      }
      // Basic format check: must start with sk-ant-
      const valid = typeof account.sessionKey === 'string' && account.sessionKey.startsWith('sk-ant-');
      if (!valid) {
        account.status = 'banned';
        results.push({ id: account.id, email: account.email, result: 'banned' });
      } else {
        results.push({ id: account.id, email: account.email, result: 'ok' });
      }
    }
  });
  return res.json({ ok: true, results });
});

// Test a single account: verify sessionKey format; mark obviously invalid ones as banned
app.post('/api/admin/accounts/:id/test', authRequired, csrfRequired, async (req, res) => {
  const { id } = req.params;
  let result = null;
  await withStoreLock(async (store) => {
    const account = store.accounts.find((a) => a.id === id);
    if (!account) return;
    if (account.status === 'banned') {
      result = { id: account.id, email: account.email, result: 'skipped_banned' };
      return;
    }
    const valid = typeof account.sessionKey === 'string' && account.sessionKey.startsWith('sk-ant-');
    if (!valid) {
      account.status = 'banned';
      result = { id: account.id, email: account.email, result: 'banned' };
    } else {
      result = { id: account.id, email: account.email, result: 'ok' };
    }
  });
  if (!result) {
    return res.status(404).json({ error: 'account_not_found' });
  }
  return res.json({ ok: true, ...result });
});

// Restore rate-limited / banned account back to active
app.post('/api/admin/accounts/:id/unrate', authRequired, csrfRequired, async (req, res) => {
  const { id } = req.params;
  let found = false;
  await withStoreLock(async (store) => {
    const account = store.accounts.find((a) => a.id === id);
    if (account) {
      account.status = 'active';
      found = true;
    }
  });
  if (!found) {
    return res.status(404).json({ error: 'account_not_found' });
  }
  return res.json({ ok: true });
});

app.delete('/api/admin/accounts/:id', authRequired, csrfRequired, async (req, res) => {
  const { id } = req.params;
  let found = false;
  await withStoreLock(async (store) => {
    const before = store.accounts.length;
    store.accounts = store.accounts.filter((a) => a.id !== id);
    found = store.accounts.length < before;
  });
  if (!found) {
    return res.status(404).json({ error: 'account_not_found' });
  }
  return res.json({ ok: true });
});

app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/admin'));

const port = Number(process.env.PORT || 8080);
function startServer(listenPort = port) {
  return app.listen(listenPort, () => {
    // eslint-disable-next-line no-console
    console.log(`claude2api local app listening on :${listenPort}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer
};

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readStore, withStoreLock } = require('./store');

const app = express();

const KNOWN_MODELS = new Set([
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4-6'
]);

let rrIndex = 0;

function toMillis(ts) {
  return new Date(ts).getTime();
}

function getTodayStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function resolveModel(requestModel) {
  if (!requestModel || typeof requestModel !== 'string') {
    return 'claude-sonnet-5';
  }

  const normalized = requestModel.trim();
  if (KNOWN_MODELS.has(normalized)) {
    return normalized;
  }

  return 'claude-sonnet-5';
}

function pickAccount(store) {
  const actives = store.accounts.filter((a) => a.status === 'active');
  if (!actives.length) {
    return null;
  }
  const account = actives[rrIndex % actives.length];
  rrIndex += 1;
  return account;
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
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== apiKey) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  return next();
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
if (!process.env.CLAUDE_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('CLAUDE_API_KEY is not set; /v1/messages is unauthenticated.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
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
  const requestedModel = req.body?.model;
  const routedModel = resolveModel(requestedModel);
  let account = null;

  await withStoreLock(async (store) => {
    account = pickAccount(store);
    if (!account) return;

    store.usageEvents.push({
      accountId: account.id,
      requestedModel: requestedModel || null,
      routedModel,
      timestamp: new Date().toISOString(),
      success: true
    });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    store.usageEvents = store.usageEvents.filter((e) => toMillis(e.timestamp) >= cutoff);
  });

  if (!account) {
    return res.status(503).json({ error: 'no_active_account' });
  }

  return res.json({
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: routedModel,
    content: [
      {
        type: 'text',
        text: 'Local compatibility mode response.'
      }
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 0,
      output_tokens: 0
    },
    meta: {
      requested_model: requestedModel || null,
      routed_model: routedModel,
      account_id: account.id
    }
  });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const store = await readStore();
  const dummyHash = '$2b$10$8vWj5N5Y6Q4f4VVRx8JYtODQx95Ds2N7N5tbJvMNCc2N6fMCRkgxK';
  const hash = username === store.adminUser ? store.adminPassHash : dummyHash;
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

app.post('/api/admin/logout', authRequired, csrfRequired, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', authRequired, (req, res) => {
  res.json({ ok: true, user: req.session.adminUser });
});

app.post('/api/admin/password', authRequired, csrfRequired, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'new_password_too_short' });
  }

  let updated = false;
  await withStoreLock(async (lockedStore) => {
    const oldOk = bcrypt.compareSync(oldPassword || '', lockedStore.adminPassHash);
    if (!oldOk) {
      return;
    }
    lockedStore.adminPassHash = bcrypt.hashSync(newPassword, 10);
    updated = true;
  });
  if (!updated) {
    return res.status(400).json({ error: 'old_password_invalid' });
  }
  return res.json({ ok: true });
});

app.get('/api/stats/accounts', authRequired, async (req, res) => {
  const store = await readStore();
  res.json({ items: computeAccountStats(store) });
});

app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/admin'));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`claude2api local app listening on :${port}`);
});

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
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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

function extractTextFromBlock(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      return block.content;
    }
    if (Array.isArray(block.content)) {
      return block.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('\n');
    }
  }
  return '';
}

function getLatestUserPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const blocks = normalizeContent(msg.content);
    const text = blocks.map(extractTextFromBlock).filter(Boolean).join('\n').trim();
    if (text) return text;
  }
  return '';
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

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
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

function estimateRequestTokens(messages, tools, thinking) {
  let totalChars = 0;
  for (const msg of messages || []) {
    totalChars += String(msg?.role || '').length;
    const blocks = normalizeContent(msg?.content);
    for (const block of blocks) {
      if (typeof block?.text === 'string') {
        totalChars += block.text.length;
      }
      if (typeof block?.thinking === 'string') {
        totalChars += block.thinking.length;
      }
      if (typeof block?.name === 'string') {
        totalChars += block.name.length;
      }
      if (block?.input && typeof block.input === 'object') {
        totalChars += JSON.stringify(block.input).length;
      }
      if (block?.source && typeof block.source === 'object') {
        const raw = block.source.data;
        if (typeof raw === 'string') {
          totalChars += raw.length;
        }
      }
    }
  }
  for (const tool of tools || []) {
    totalChars += String(tool?.name || '').length;
    totalChars += String(tool?.description || '').length;
    if (tool?.input_schema && typeof tool.input_schema === 'object') {
      totalChars += JSON.stringify(tool.input_schema).length;
    }
  }
  if (thinking) {
    totalChars += JSON.stringify(thinking).length;
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

function pickTool(tools, choiceType, choiceName, prompt) {
  if (!tools.length || choiceType === 'none') return null;
  if (choiceType === 'tool' && choiceName) {
    return tools.find((t) => t?.name === choiceName) || null;
  }
  if (choiceType === 'any') {
    return tools[0];
  }
  if (choiceType === 'auto') {
    // Local stub cannot truly "decide like a model", so only trigger tool use
    // when users provide an explicit tool-intent phrase.
    const explicitToolIntent = /\buse[_ -]?tool\b|请调用工具|调用工具/.test(prompt || '');
    return explicitToolIntent ? tools[0] : null;
  }
  return null;
}

function buildToolInput(prompt, imageCount) {
  const query = (prompt || '').trim() || 'no_query';
  return {
    query: query.slice(0, 300),
    image_count: imageCount
  };
}

function chunkText(text, size = 32) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildLocalText(prompt, imageCount) {
  const safePrompt = (prompt || '').slice(0, 300);
  const summary = safePrompt ? `You said: ${safePrompt}` : 'Message received.';
  const imageInfo = imageCount > 0 ? ` (${imageCount} image input(s) detected)` : '';
  return `Local compatibility response. ${summary}${imageInfo}`;
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
  if (!timingSafeStringEqual(token, apiKey)) {
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
  const requestedModel = req.body?.model;
  const routedModel = resolveModel(requestedModel);
  const stream = Boolean(req.body?.stream);
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const tools = Array.isArray(req.body?.tools) ? req.body.tools.filter((t) => t?.name) : [];
  const toolChoiceType = req.body?.tool_choice?.type || 'auto';
  const toolChoiceName = req.body?.tool_choice?.name;
  const prompt = getLatestUserPrompt(messages);
  const imageCount = countInputImages(messages);
  const withThinking = thinkingEnabled(req.body, routedModel);
  const selectedTool = pickTool(tools, toolChoiceType, toolChoiceName, prompt);
  const toolUse = selectedTool
    ? {
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: selectedTool.name,
        input: buildToolInput(prompt, imageCount)
      }
    : null;
  const textReply = buildLocalText(prompt, imageCount);
  const thinkingReply = `分析中：本地兼容层已解析请求，模型路由为 ${routedModel}。`;
  const inputTokens = estimateRequestTokens(messages, tools, req.body?.thinking || null);
  const outputTokens = estimateTokens(
    toolUse ? JSON.stringify(toolUse.input) : `${withThinking ? thinkingReply : ''}${textReply}`
  );
  const stopReason = toolUse ? 'tool_use' : 'end_turn';
  let account = null;

  await withStoreLock(async (store) => {
    account = pickAccount(store);
    if (!account) return;

    store.usageEvents.push({
      accountId: account.id,
      requestedModel: requestedModel || null,
      routedModel,
      stream,
      hasTools: tools.length > 0,
      usedTool: Boolean(toolUse),
      hasImages: imageCount > 0,
      hasThinking: withThinking,
      timestamp: new Date().toISOString(),
      success: true
    });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    store.usageEvents = store.usageEvents.filter((e) => toMillis(e.timestamp) >= cutoff);
  });

  if (!account) {
    return res.status(503).json({ error: 'no_active_account' });
  }

  const messageId = `msg_${crypto.randomUUID()}`;
  const content = [];
  if (withThinking) {
    content.push({
      type: 'thinking',
      thinking: thinkingReply
    });
  }
  if (toolUse) {
    content.push({
      type: 'tool_use',
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input
    });
  } else {
    content.push({
      type: 'text',
      text: textReply
    });
  }

  if (!stream) {
    return res.json({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: routedModel,
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      },
      meta: {
        requested_model: requestedModel || null,
        routed_model: routedModel,
        account_id: account.id
      }
    });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: routedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0
      }
    }
  });

  let blockIndex = 0;
  if (withThinking) {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'thinking',
        thinking: ''
      }
    });
    for (const chunk of chunkText(thinkingReply)) {
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'thinking_delta',
          thinking: chunk
        }
      });
    }
    writeSse(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex
    });
    blockIndex += 1;
  }

  if (toolUse) {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: {}
      }
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolUse.input)
      }
    });
    writeSse(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex
    });
  } else {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'text',
        text: ''
      }
    });
    for (const chunk of chunkText(textReply)) {
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'text_delta',
          text: chunk
        }
      });
    }
    writeSse(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex
    });
  }

  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null
    },
    usage: {
      output_tokens: outputTokens
    }
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  return res.end();
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
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`claude2api local app listening on :${port}`);
});

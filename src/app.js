const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readStore, withStoreLock } = require('./store');

const app = express();

const CLAUDE_WEB_BASE = (process.env.CLAUDE_WEB_BASE || 'https://claude.ai').replace(/\/$/, '');

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

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
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

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Account Pool ──────────────────────────────────────────────────────────

function pickAccount(store) {
  const now = Date.now();
  const todayStart = getTodayStart(new Date(now));
  const active = store.accounts.filter((a) => {
    if (a.status !== 'active') return false;
    const limit = Number(a.dailyLimit || 0);
    if (limit <= 0) return true;
    const todayCount = store.usageEvents.filter(
      (e) => e.accountId === a.id && toMillis(e.timestamp) >= todayStart
    ).length;
    return todayCount < limit;
  });
  if (!active.length) return null;
  const chosen = active[rrIndex % active.length];
  rrIndex = (rrIndex + 1) % active.length;
  return chosen;
}

// ── Claude.ai Web Transport ───────────────────────────────────────────────

function buildWebHeaders(sessionKey, extra) {
  return Object.assign({
    Cookie: `sessionKey=${sessionKey}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${CLAUDE_WEB_BASE}/`
  }, extra || {});
}

async function fetchWithShortTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function getWebOrgId(sessionKey) {
  const res = await fetchWithShortTimeout(
    `${CLAUDE_WEB_BASE}/api/organizations`,
    { method: 'GET', headers: buildWebHeaders(sessionKey, { Accept: 'application/json' }) }
  );
  if (!res.ok) {
    throw Object.assign(new Error(`getOrgId HTTP ${res.status}`), { httpStatus: res.status });
  }
  const orgs = await res.json();
  if (!Array.isArray(orgs) || !orgs.length) throw new Error('no organizations found');
  return orgs[0].uuid;
}

async function createWebConversation(sessionKey, orgId, convUuid) {
  const res = await fetchWithShortTimeout(
    `${CLAUDE_WEB_BASE}/api/organizations/${orgId}/chat_conversations`,
    {
      method: 'POST',
      headers: buildWebHeaders(sessionKey, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ uuid: convUuid, name: '' })
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`createConversation HTTP ${res.status}: ${text}`),
      { httpStatus: res.status }
    );
  }
}

function buildWebPrompt(messages, tools, systemText) {
  const parts = [];

  if (systemText) {
    parts.push(`<system>\n${systemText}\n</system>`);
  }

  if (tools && tools.length > 0) {
    let toolDefs = 'You have access to the following tools. When you need to use a tool, output:\n<tool_use>\n{"name": "tool_name", "input": {...}}\n</tool_use>';
    for (const tool of tools) {
      let def = `Tool: ${tool.name}`;
      if (tool.description) def += `\nDescription: ${tool.description}`;
      if (tool.input_schema) def += `\nInput schema: ${JSON.stringify(tool.input_schema)}`;
      toolDefs += `\n\n${def}`;
    }
    parts.push(toolDefs);
  }

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'Human';
    const blocks = normalizeContent(msg.content);
    const text = blocks.map((b) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') {
        return `<tool_use>\n${JSON.stringify({ name: b.name, input: b.input })}\n</tool_use>`;
      }
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((p) => p.text || '').join('\n') : '';
        return `<tool_result id="${b.tool_use_id}">\n${c}\n</tool_result>`;
      }
      if (b.type === 'image') return '[image]';
      return '';
    }).filter(Boolean).join('\n\n');
    parts.push(`${role}: ${text}`);
  }

  return parts.join('\n\n');
}

function parseToolUseFromText(text, tools) {
  if (!tools || !tools.length || !text) return null;
  const match = text.match(/<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.name) return null;
    return {
      type: 'tool_use',
      id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: parsed.name,
      input: parsed.input || {}
    };
  } catch {
    return null;
  }
}

async function proxyToClaudeWeb(req, res, account) {
  const body = req.body || {};
  const stream = Boolean(body.stream);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const system = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map((b) => (b.type === 'text' ? b.text : '')).join('\n') : '';
  const requestedModel = typeof body.model === 'string' ? body.model : 'claude-sonnet-4-6';
  const { sessionKey } = account;

  const orgId = await getWebOrgId(sessionKey);
  const convUuid = crypto.randomUUID();
  await createWebConversation(sessionKey, orgId, convUuid);

  const prompt = buildWebPrompt(messages, tools, system);
  const webBody = {
    prompt,
    attachments: [],
    files: [],
    model: requestedModel,
    rendering_mode: 'rich',
    timezone: 'UTC'
  };

  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  req.on('close', () => controller.abort());

  let webRes;
  try {
    webRes = await fetch(
      `${CLAUDE_WEB_BASE}/api/organizations/${orgId}/chat_conversations/${convUuid}/completion`,
      {
        method: 'POST',
        headers: buildWebHeaders(sessionKey, {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'anthropic-client-platform': 'web_claude_ai'
        }),
        body: JSON.stringify(webBody),
        signal: controller.signal
      }
    );
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }

  if (!webRes.ok) {
    if (timer) clearTimeout(timer);
    const httpStatus = webRes.status;
    const errText = await webRes.text().catch(() => '');
    throw Object.assign(new Error(errText || `HTTP ${httpStatus}`), { httpStatus });
  }

  const messageId = `msg_${crypto.randomUUID()}`;
  let fullText = '';
  let stopReason = 'end_turn';
  let outputTokens = 0;
  const inputTokens = estimateTokens(prompt);

  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', model: requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    });
  }

  let blockIndex = 0;
  let textBlockOpen = false;

  try {
    let buf = '';
    for await (const rawChunk of webRes.body) {
      buf += Buffer.from(rawChunk).toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (!raw || raw === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (typeof evt.type === 'string') {
          // Modern format: events look like Anthropic API events
          if (evt.type === 'content_block_start' && evt.content_block && evt.content_block.type === 'text') {
            if (stream) {
              writeSse(res, 'content_block_start', Object.assign({}, evt, { index: blockIndex }));
              textBlockOpen = true;
            }
          } else if (evt.type === 'content_block_delta') {
            const text = (evt.delta && (evt.delta.text || evt.delta.thinking)) || '';
            fullText += text;
            outputTokens += estimateTokens(text);
            if (stream) writeSse(res, 'content_block_delta', Object.assign({}, evt, { index: blockIndex }));
          } else if (evt.type === 'content_block_stop') {
            if (stream && textBlockOpen) {
              writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
              textBlockOpen = false;
              blockIndex += 1;
            }
          } else if (evt.type === 'message_delta') {
            if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
            if (evt.usage && evt.usage.output_tokens) outputTokens = evt.usage.output_tokens;
          }
          // message_stop handled after loop
        } else if (typeof evt.completion === 'string') {
          // Legacy claude.ai format: {"completion": "...", "stop_reason": null}
          const text = evt.completion;
          if (text) {
            fullText += text;
            outputTokens += estimateTokens(text);
            if (stream) {
              if (!textBlockOpen) {
                writeSse(res, 'content_block_start', {
                  type: 'content_block_start', index: blockIndex,
                  content_block: { type: 'text', text: '' }
                });
                textBlockOpen = true;
              }
              writeSse(res, 'content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text }
              });
            }
          }
          if (evt.stop_reason && evt.stop_reason !== 'null') {
            stopReason = evt.stop_reason === 'stop_sequence' ? 'stop_sequence' : 'end_turn';
          }
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Parse ReAct-style tool use from accumulated text
  const toolUse = parseToolUseFromText(fullText, tools);
  if (toolUse) stopReason = 'tool_use';

  if (stream) {
    if (textBlockOpen) {
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex += 1;
    }
    if (toolUse) {
      writeSse(res, 'content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} }
      });
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) }
      });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
    return res.end();
  }

  const content = toolUse ? [toolUse] : [{ type: 'text', text: fullText }];
  return res.json({
    id: messageId, type: 'message', role: 'assistant', model: requestedModel,
    content, stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  });
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
  let accountId = null;

  // Optional override: if UPSTREAM_MESSAGES_URL is configured, proxy directly to it
  if (upstreamUrl) {
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
  }

  // No upstream URL: pick an active Web account and proxy via Claude.ai web transport
  let account = null;
  await withStoreLock(async (store) => {
    account = pickAccount(store);
  });

  if (!account) {
    return res.status(503).json({ error: 'no_active_account', message: 'no active account available' });
  }

  try {
    await proxyToClaudeWeb(req, res, account);
    success = true;
    accountId = account.id;
  } catch (err) {
    success = false;
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      if (!res.headersSent) {
        return res.status(504).json({ error: 'request_timeout', message: 'request timed out' });
      }
      return;
    }
    const httpStatus = err?.httpStatus;
    if (httpStatus === 401 || httpStatus === 403) {
      await withStoreLock(async (store) => {
        const acc = store.accounts.find((a) => a.id === account.id);
        if (acc) acc.status = 'banned';
      });
      if (!res.headersSent) {
        return res.status(502).json({ error: 'account_auth_failed', message: 'session key rejected' });
      }
      return;
    }
    if (httpStatus === 429) {
      await withStoreLock(async (store) => {
        const acc = store.accounts.find((a) => a.id === account.id);
        if (acc) acc.status = 'rate_limited';
      });
      if (!res.headersSent) {
        return res.status(429).json({ error: 'rate_limited', message: 'account rate limited' });
      }
      return;
    }
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'web_request_failed',
        message: err instanceof Error ? err.message : 'unknown_error'
      });
    }
  } finally {
    await withStoreLock(async (store) => {
      store.usageEvents.push({
        accountId,
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

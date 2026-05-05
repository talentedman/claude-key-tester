const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-opus-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ENABLE_1M_CONTEXT = process.env.DEFAULT_ENABLE_1M_CONTEXT !== '0';
const CONTEXT_1M_BETA = process.env.CONTEXT_1M_BETA || 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24';

const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const SESSION_ID = crypto.randomUUID();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeBaseUrl(input) {
  const base = String(input || '').trim();
  if (!base) {
    throw new Error('baseUrl 不能为空');
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('baseUrl 必须以 http:// 或 https:// 开头');
  }
  return base.replace(/\/+$/, '');
}

function apiHeaders(apiKey, anthropicBeta = '') {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'authorization': `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'user-agent': 'claude-cli/2.1.118 (external, cli)',
  };
  if (anthropicBeta) {
    headers['anthropic-beta'] = anthropicBeta;
  }
  return headers;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return { rawText: text, json: JSON.parse(text) };
  } catch {
    return { rawText: text, json: null };
  }
}

function extractReplyText(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function parseSSEText(sse) {
  const out = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        out.push(evt.delta.text || '');
      }
    } catch {}
  }
  return out.join('').trim();
}

function extractErrMsg(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.error && typeof body.error === 'object') {
    return body.error.message || JSON.stringify(body.error);
  }
  if (body.message) return String(body.message);
  return JSON.stringify(body);
}

function maybeModelIssue(status, body) {
  const msg = extractErrMsg(body).toLowerCase();
  if (!msg) return status >= 500;
  if ([400, 404, 422].includes(status) && /(model|unknown model|invalid model|not found|not available|unsupported)/i.test(msg)) {
    return true;
  }
  if (status >= 500 && /(panic|nil pointer|invalid memory|runtime error)/i.test(msg)) {
    return true;
  }
  return false;
}

function toBool(input, fallback = false) {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const v = input.trim().toLowerCase();
    if (!v) return fallback;
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  }
  return fallback;
}

function append1mSuffix(model) {
  if (!model) return model;
  return /\[1m\]$/i.test(model) ? model : `${model}[1m]`;
}

function dedupeAttempts(attempts) {
  const seen = new Set();
  const out = [];
  for (const attempt of attempts) {
    const key = `${attempt.model}||${attempt.anthropicBeta || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attempt);
  }
  return out;
}

function normalizeModelDots(model) {
  if (!model) return model;
  return model.replace(/(claude-[a-z]+)-(\d+)\.(\d+)/i, '$1-$2-$3');
}

function buildAttempts(model, enable1m) {
  const attempts = [];
  const variants = [model];
  const dashed = normalizeModelDots(model);
  if (dashed && dashed !== model) variants.push(dashed);

  for (const m of variants) {
    if (enable1m) {
      attempts.push({ model: m, anthropicBeta: CONTEXT_1M_BETA, note: 'beta header + ?beta=true' });
    }
    attempts.push({ model: m, anthropicBeta: '', note: 'no beta' });
  }

  return dedupeAttempts(attempts);
}

async function callMessages({ baseUrl, apiKey, model, prompt, anthropicBeta = '', maxTokens = 256 }) {
  const useBetaQuery = !!anthropicBeta;
  const endpoint = `${baseUrl}/v1/messages${useBetaQuery ? '?beta=true' : ''}`;
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (anthropicBeta) {
    body.stream = true;
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: 'xhigh' };
    body.metadata = {
      user_id: JSON.stringify({
        device_id: DEVICE_ID,
        account_uuid: '',
        session_id: SESSION_ID,
      }),
    };
    body.system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
    ];
    body.messages = [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }];
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: apiHeaders(apiKey, anthropicBeta),
    body: JSON.stringify(body),
  });

  if (anthropicBeta && response.ok && response.headers.get('content-type')?.includes('event-stream')) {
    const text = await response.text();
    const replyText = parseSSEText(text);
    return {
      ok: true,
      status: response.status,
      endpoint,
      body: { stream: true, events: text.length },
      rawText: '',
      replyText,
    };
  }

  const parsed = await readResponse(response);
  return {
    ok: response.ok,
    status: response.status,
    endpoint,
    body: parsed.json,
    rawText: parsed.rawText,
    replyText: extractReplyText(parsed.json),
  };
}

async function listModels(baseUrl, apiKey, anthropicBeta = '') {
  const endpoint = `${baseUrl}/v1/models`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: apiHeaders(apiKey, anthropicBeta),
  });
  const parsed = await readResponse(response);
  const ids = Array.isArray(parsed.json?.data)
    ? parsed.json.data.map((m) => m?.id).filter(Boolean)
    : [];

  return {
    ok: response.ok,
    status: response.status,
    endpoint,
    body: parsed.json,
    rawText: parsed.rawText,
    modelIds: ids,
  };
}

app.post('/api/test', async (req, res) => {
  const start = Date.now();
  try {
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    const apiKey = String(req.body?.apiKey || '').trim();
    const prompt = String(req.body?.prompt || '').trim();
    const inputModel = String(req.body?.model || '').trim() || DEFAULT_MODEL;
    const enable1m = toBool(req.body?.enable1m, DEFAULT_ENABLE_1M_CONTEXT);

    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'apiKey 不能为空' });
    }
    if (!prompt) {
      return res.status(400).json({ success: false, message: '测试文案不能为空' });
    }

    let usedModel = inputModel;
    let usedAnthropicBeta = '';
    let result = null;
    let fallbackTried = false;
    let modelCandidates = [];
    const attemptsLog = [];

    const attempts = buildAttempts(inputModel, enable1m);
    for (const attempt of attempts) {
      const current = await callMessages({
        baseUrl,
        apiKey,
        model: attempt.model,
        prompt,
        anthropicBeta: attempt.anthropicBeta,
      });

      attemptsLog.push({
        model: attempt.model,
        anthropicBeta: attempt.anthropicBeta || undefined,
        note: attempt.note,
        status: current.status,
        ok: current.ok,
      });

      result = current;
      usedModel = attempt.model;
      usedAnthropicBeta = attempt.anthropicBeta || '';
      if (current.ok) break;
      if ([502, 503, 504].includes(current.status)) break;
    }

    if (result && !result.ok && maybeModelIssue(result.status, result.body || result.rawText)) {
      const models = await listModels(baseUrl, apiKey, usedAnthropicBeta);
      modelCandidates = models.modelIds;
      const fallbackModel = modelCandidates[0];

      if (fallbackModel && fallbackModel !== usedModel) {
        fallbackTried = true;
        const retry = await callMessages({
          baseUrl,
          apiKey,
          model: fallbackModel,
          prompt,
          anthropicBeta: usedAnthropicBeta,
        });
        attemptsLog.push({
          model: fallbackModel,
          anthropicBeta: usedAnthropicBeta || undefined,
          note: 'fallback(first model from /v1/models)',
          status: retry.status,
          ok: retry.ok,
        });
        usedModel = fallbackModel;
        result = retry;
      }
    }

    if (!result) {
      throw new Error('未执行任何请求');
    }

    const upstreamBusy = !result.ok && [502, 503, 504].includes(result.status);
    const canUseKey = result.ok || upstreamBusy;

    const durationMs = Date.now() - start;
    return res.status(result.ok ? 200 : result.status).json({
      success: result.ok,
      canUseKey,
      upstreamBusy: upstreamBusy || undefined,
      durationMs,
      request: {
        baseUrl,
        endpoint: '/v1/messages',
        anthropicVersion: ANTHROPIC_VERSION,
        model: usedModel,
        enable1m,
        anthropicBeta: usedAnthropicBeta || undefined,
        fallbackTried,
        modelCandidates,
        attempts: attemptsLog,
      },
      response: {
        status: result.status,
        replyText: result.replyText,
        body: result.body,
        rawText: result.body ? undefined : result.rawText,
      },
      message: result.ok
        ? 'Key 可用，消息请求成功'
        : upstreamBusy
          ? `Key 应该可用：上游临时不可用 (HTTP ${result.status})，认证已通过`
          : `请求失败：${extractErrMsg(result.body || result.rawText) || `HTTP ${result.status}`}`,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      canUseKey: false,
      message: err?.message || '服务端异常',
    });
  }
});

app.post('/api/models', async (req, res) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'apiKey 不能为空' });
    }
    const result = await listModels(baseUrl, apiKey);
    return res.status(result.ok ? 200 : result.status).json({
      success: result.ok,
      modelIds: result.modelIds,
      message: result.ok ? '' : extractErrMsg(result.body || result.rawText) || `HTTP ${result.status}`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || '服务端异常' });
  }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`claude-key-tester listening on http://0.0.0.0:${PORT}`);
});

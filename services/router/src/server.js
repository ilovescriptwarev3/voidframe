import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cors, fail, httpError, json, readBody, requireToken, send } from './http.js';

const SERVICE = 'router';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8089);
const startedAt = Date.now();
const CHAT_TIMEOUT = 60000;
const KEYCHAIN_TIMEOUT = 2000;

const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const BASES = {
  openai: trimSlash(process.env.VF_ROUTER_OPENAI_BASE_URL || 'https://api.openai.com/v1'),
  anthropic: trimSlash(process.env.VF_ROUTER_ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
  gemini: trimSlash(process.env.VF_ROUTER_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'),
  openrouter: trimSlash(process.env.VF_ROUTER_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
};

const PROVIDER_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_URL',
};

const CATALOG = [
  { id: 'gpt-4o-mini', provider: 'openai', kind: 'chat', cost_in: 0.15, cost_out: 0.6 },
  { id: 'gpt-4o', provider: 'openai', kind: 'chat', cost_in: 2.5, cost_out: 10 },
  { id: 'gpt-4.1-mini', provider: 'openai', kind: 'chat', cost_in: 0.4, cost_out: 1.6 },
  { id: 'text-embedding-3-small', provider: 'openai', kind: 'embedding', cost_in: 0.02, cost_out: 0 },
  { id: 'text-embedding-3-large', provider: 'openai', kind: 'embedding', cost_in: 0.13, cost_out: 0 },
  { id: 'claude-sonnet-4-20250514', provider: 'anthropic', kind: 'chat', cost_in: 3, cost_out: 15 },
  { id: 'claude-3-5-sonnet-20241022', provider: 'anthropic', kind: 'chat', cost_in: 3, cost_out: 15 },
  { id: 'claude-3-5-haiku-20241022', provider: 'anthropic', kind: 'chat', cost_in: 0.8, cost_out: 4 },
  { id: 'gemini-1.5-pro', provider: 'gemini', kind: 'chat', cost_in: 1.25, cost_out: 5 },
  { id: 'gemini-2.0-flash', provider: 'gemini', kind: 'chat', cost_in: 0.1, cost_out: 0.4 },
  { id: 'openrouter/auto', provider: 'openrouter', kind: 'chat', cost_in: 0, cost_out: 0 },
  { id: 'llama3.1', provider: 'ollama', kind: 'chat', cost_in: 0, cost_out: 0 },
  { id: 'qwen2.5', provider: 'ollama', kind: 'chat', cost_in: 0, cost_out: 0 },
  { id: 'nomic-embed-text', provider: 'ollama', kind: 'embedding', cost_in: 0, cost_out: 0 },
];

const usage = { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, by_model: {} };

if (!process.env.VF_SERVICE_TOKEN) {
  process.stderr.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'warn',
      event: 'missing_service_token',
      fields: { message: 'VF_SERVICE_TOKEN is not set; using the development default.' },
    }) + '\n',
  );
}

function report(level, event, fields = {}) {
  const base = process.env.LENS_URL;
  if (!base) return;
  fetch(`${base.replace(/\/+$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: SERVICE, level, event, fields }),
    signal: AbortSignal.timeout(300),
  }).catch(() => {});
}

function pathOf(raw) {
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return String(raw || '');
  }
}

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

function findModel(id) {
  return CATALOG.find((entry) => entry.id === id) || null;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function normalizeUsage(raw) {
  const prompt = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0) || 0;
  const completion = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0) || 0;
  const total = Number(raw?.total_tokens ?? prompt + completion) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function recordUsage(model, tokensIn, tokensOut, cost) {
  usage.calls += 1;
  usage.tokens_in += tokensIn;
  usage.tokens_out += tokensOut;
  usage.cost_usd += cost;
  if (!usage.by_model[model]) {
    usage.by_model[model] = { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  }
  const row = usage.by_model[model];
  row.calls += 1;
  row.tokens_in += tokensIn;
  row.tokens_out += tokensOut;
  row.cost_usd += cost;
}

async function keychainValue(name) {
  const base = trimSlash(process.env.KEYCHAIN_URL || 'http://localhost:8087');
  try {
    const res = await fetch(`${base}/v1/secrets/${encodeURIComponent(name)}`, {
      headers: { 'x-vf-token': process.env.VF_SERVICE_TOKEN || 'dev-token-change-me' },
      signal: AbortSignal.timeout(KEYCHAIN_TIMEOUT),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.value === 'string' && data.value ? data.value : null;
  } catch {
    return null;
  }
}

async function allCredentials() {
  const providers = Object.keys(PROVIDER_ENV);
  const values = await Promise.all(providers.map((provider) => keychainValue(PROVIDER_ENV[provider])));
  const out = {};
  providers.forEach((provider, index) => {
    out[provider] = values[index];
  });
  return out;
}

async function getCredential(provider) {
  return keychainValue(PROVIDER_ENV[provider]);
}

async function upstreamFetch(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CHAT_TIMEOUT) });
  } catch (err) {
    throw httpError(502, 'provider_error', `Provider request failed: ${err.message}`);
  }
}

async function upstreamError(res) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {}
  return httpError(
    502,
    'provider_error',
    `Upstream provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
  );
}

function finalizeChat(entry, result, started) {
  const cost =
    (result.usage.prompt_tokens / 1000) * entry.cost_in +
    (result.usage.completion_tokens / 1000) * entry.cost_out;
  result.vf = {
    provider: entry.provider,
    cost_usd: roundCost(cost),
    latency_ms: Date.now() - started,
  };
  recordUsage(entry.id, result.usage.prompt_tokens, result.usage.completion_tokens, cost);
  return result;
}

async function openaiLikeChat(entry, body, key, base) {
  const payload = { model: entry.id, messages: body.messages };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  const res = await upstreamFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  const choices = (Array.isArray(data.choices) ? data.choices : []).map((choice, index) => ({
    index: choice.index ?? index,
    message: {
      role: choice.message?.role || 'assistant',
      content: contentText(choice.message?.content),
    },
    finish_reason: choice.finish_reason || 'stop',
  }));
  return {
    id: data.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: data.created || Math.floor(Date.now() / 1000),
    model: data.model || entry.id,
    choices,
    usage: normalizeUsage(data.usage),
  };
}

const STOP_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

async function anthropicChat(entry, body, key) {
  const systemParts = [];
  const messages = [];
  for (const message of body.messages) {
    if (message.role === 'system') {
      systemParts.push(contentText(message.content));
    } else {
      messages.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: contentText(message.content),
      });
    }
  }
  const payload = {
    model: entry.id,
    max_tokens: body.max_tokens || 1024,
    messages,
  };
  if (systemParts.length) payload.system = systemParts.join('\n');
  if (body.temperature !== undefined) payload.temperature = body.temperature;

  const res = await upstreamFetch(`${BASES.anthropic}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  const content = Array.isArray(data.content)
    ? data.content.filter((part) => part && part.type === 'text').map((part) => part.text || '').join('')
    : '';
  return {
    id: data.id || `msg_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || entry.id,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: STOP_REASONS[data.stop_reason] || data.stop_reason || 'stop',
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

async function geminiChat(entry, body, key) {
  const systemParts = [];
  const contents = [];
  for (const message of body.messages) {
    if (message.role === 'system') {
      systemParts.push(contentText(message.content));
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: contentText(message.content) }],
    });
  }
  const payload = { contents };
  if (systemParts.length) payload.systemInstruction = { parts: [{ text: systemParts.join('\n') }] };
  const generationConfig = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

  const url = `${BASES.gemini}/v1beta/models/${encodeURIComponent(entry.id)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await upstreamFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  const candidate = data.candidates?.[0] || {};
  const content = Array.isArray(candidate.content?.parts)
    ? candidate.content.parts.map((part) => part.text || '').join('')
    : '';
  const meta = data.usageMetadata || {};
  return {
    id: `gemini_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: entry.id,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: STOP_REASONS[candidate.finishReason] || candidate.finishReason || 'stop',
      },
    ],
    usage: {
      prompt_tokens: meta.promptTokenCount || 0,
      completion_tokens: meta.candidatesTokenCount || 0,
      total_tokens: meta.totalTokenCount || (meta.promptTokenCount || 0) + (meta.candidatesTokenCount || 0),
    },
  };
}

async function ollamaChat(entry, body, key) {
  const url = trimSlash(key);
  const payload = {
    model: entry.id,
    messages: body.messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
      content: contentText(message.content),
    })),
    stream: false,
  };
  const options = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.max_tokens !== undefined) options.num_predict = body.max_tokens;
  if (Object.keys(options).length) payload.options = options;

  const res = await upstreamFetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  return {
    id: `ollama_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || entry.id,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: data.message?.content || '' },
        finish_reason: data.done ? 'stop' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    },
  };
}

function providerChat(entry, body, key) {
  if (entry.provider === 'openai') return openaiLikeChat(entry, body, key, BASES.openai);
  if (entry.provider === 'openrouter') return openaiLikeChat(entry, body, key, BASES.openrouter);
  if (entry.provider === 'anthropic') return anthropicChat(entry, body, key);
  if (entry.provider === 'gemini') return geminiChat(entry, body, key);
  if (entry.provider === 'ollama') return ollamaChat(entry, body, key);
  throw httpError(502, 'provider_error', `Provider "${entry.provider}" is not supported.`);
}

async function openaiEmbeddings(entry, body, key, base) {
  const res = await upstreamFetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: entry.id, input: body.input }),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  const promptTokens = Number(data.usage?.prompt_tokens ?? 0) || 0;
  return {
    response: {
      object: 'list',
      data: (Array.isArray(data.data) ? data.data : []).map((item, index) => ({
        index: item.index ?? index,
        embedding: item.embedding,
      })),
      model: data.model || entry.id,
      usage: { prompt_tokens: promptTokens, total_tokens: Number(data.usage?.total_tokens ?? promptTokens) || promptTokens },
    },
    promptTokens,
  };
}

async function ollamaEmbeddings(entry, body, key) {
  const url = trimSlash(key);
  const res = await upstreamFetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: entry.id, input: body.input }),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  const promptTokens = Number(data.prompt_eval_count ?? 0) || 0;
  return {
    response: {
      object: 'list',
      data: (Array.isArray(data.embeddings) ? data.embeddings : []).map((embedding, index) => ({
        index,
        embedding,
      })),
      model: entry.id,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    },
    promptTokens,
  };
}

function normalizeEmbeddingInput(input) {
  if (typeof input === 'string') return input.trim() ? input : null;
  if (Array.isArray(input) && input.length) {
    if (input.every((item) => typeof item === 'string')) return input;
    if (input.every((item) => typeof item === 'number')) return input;
  }
  return null;
}

async function proxyOpenAIStream(entry, body, key, res) {
  const base = entry.provider === 'openrouter' ? BASES.openrouter : BASES.openai;
  const payload = { model: entry.id, messages: body.messages, stream: true };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  const upstream = await upstreamFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!upstream.ok) throw await upstreamError(upstream);

  recordUsage(entry.id, 0, 0, 0);
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') || 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
  } finally {
    try { res.end(); } catch {}
  }
}

function synthesizeStream(res, result) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const base = {
    id: result.id,
    object: 'chat.completion.chunk',
    created: result.created,
    model: result.model,
  };
  const content = result.choices?.[0]?.message?.content || '';
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: result.choices?.[0]?.finish_reason || 'stop' }],
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

async function reachable(provider, credential) {
  try {
    let res;
    if (provider === 'openai') {
      res = await fetch(`${BASES.openai}/models`, {
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(1500),
      });
    } else if (provider === 'openrouter') {
      res = await fetch(`${BASES.openrouter}/models`, {
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(1500),
      });
    } else if (provider === 'anthropic') {
      res = await fetch(`${BASES.anthropic}/v1/models`, {
        headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(1500),
      });
    } else if (provider === 'gemini') {
      res = await fetch(`${BASES.gemini}/v1beta/models?key=${encodeURIComponent(credential)}`, {
        signal: AbortSignal.timeout(1500),
      });
    } else {
      res = await fetch(`${trimSlash(credential)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    send(res, 204);
    return;
  }

  if (method === 'GET' && path === '/healthz') {
    json(res, 200, {
      service: SERVICE,
      status: 'ok',
      version: VERSION,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    });
    return;
  }

  if (!requireToken(req, res)) return;

  if (method === 'GET' && path === '/') {
    json(res, 200, { service: SERVICE, docs: '/healthz' });
    return;
  }

  if (method === 'GET' && path === '/v1/models') {
    json(res, 200, {
      models: CATALOG.map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        cost_per_1k_in: entry.cost_in,
        cost_per_1k_out: entry.cost_out,
      })),
    });
    return;
  }

  if (method === 'GET' && path === '/v1/usage') {
    json(res, 200, {
      calls: usage.calls,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_usd: roundCost(usage.cost_usd),
      by_model: usage.by_model,
    });
    return;
  }

  if (method === 'GET' && path === '/v1/health/providers') {
    const credentials = await allCredentials();
    const providers = await Promise.all(
      Object.keys(PROVIDER_ENV).map(async (provider) => {
        const configured = Boolean(credentials[provider]);
        const reachableResult = configured ? await reachable(provider, credentials[provider]) : null;
        return { id: provider, configured, reachable: reachableResult };
      }),
    );
    return json(res, 200, { providers });
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    const body = await readBody(req);
    if (typeof body.model !== 'string' || !body.model.trim()) {
      return fail(res, 400, 'invalid_model', 'model must be a non-empty string.');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return fail(res, 400, 'invalid_messages', 'messages must be a non-empty array.');
    }
    for (const message of body.messages) {
      if (!message || typeof message.role !== 'string' || message.content === undefined) {
        return fail(res, 400, 'invalid_messages', 'every message needs a role and content.');
      }
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return fail(res, 400, 'invalid_stream', 'stream must be a boolean when provided.');
    }
    if (body.temperature !== undefined && !Number.isFinite(body.temperature)) {
      return fail(res, 400, 'invalid_temperature', 'temperature must be a finite number.');
    }
    if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
      return fail(res, 400, 'invalid_max_tokens', 'max_tokens must be a positive integer.');
    }

    const entry = findModel(body.model);
    if (!entry) return fail(res, 400, 'model_not_found', `Model "${body.model}" is not supported.`);
    if (entry.kind !== 'chat') {
      return fail(res, 400, 'model_not_chat', `Model "${entry.id}" does not support chat completions.`);
    }
    const key = await getCredential(entry.provider);
    if (!key) {
      return fail(
        res,
        503,
        'no_provider_configured',
        `No credential for provider "${entry.provider}". Add ${PROVIDER_ENV[entry.provider]} to keychain.`,
      );
    }

    const started = Date.now();
    if (body.stream) {
      if (entry.provider === 'openai' || entry.provider === 'openrouter') {
        return proxyOpenAIStream(entry, body, key, res);
      }
      const result = await providerChat(entry, body, key);
      const final = finalizeChat(entry, result, started);
      return synthesizeStream(res, final);
    }

    const result = await providerChat(entry, body, key);
    return json(res, 200, finalizeChat(entry, result, started));
  }

  if (method === 'POST' && path === '/v1/embeddings') {
    const body = await readBody(req);
    const input = normalizeEmbeddingInput(body.input);
    if (input === null) {
      return fail(res, 400, 'invalid_input', 'input must be a non-empty string, array of strings, or array of numbers.');
    }

    let entry;
    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !body.model.trim()) {
        return fail(res, 400, 'invalid_model', 'model must be a non-empty string when provided.');
      }
      entry = findModel(body.model);
      if (!entry) return fail(res, 400, 'model_not_found', `Model "${body.model}" is not supported.`);
    } else {
      const credentials = await allCredentials();
      entry = CATALOG.find((candidate) => candidate.kind === 'embedding' && credentials[candidate.provider]);
      if (!entry) {
        const anyConfigured = Object.values(credentials).some(Boolean);
        if (!anyConfigured) {
          return fail(
            res,
            503,
            'no_provider_configured',
            'No LLM provider is configured. Add OPENAI_API_KEY to keychain.',
          );
        }
        return fail(res, 501, 'embeddings_unsupported', 'No configured provider supports embeddings.');
      }
    }

    if (entry.kind !== 'embedding' || !['openai', 'ollama'].includes(entry.provider)) {
      return fail(res, 501, 'embeddings_unsupported', `Model "${entry.id}" does not support embeddings.`);
    }

    const key = await getCredential(entry.provider);
    if (!key) {
      return fail(
        res,
        503,
        'no_provider_configured',
        `No credential for provider "${entry.provider}". Add ${PROVIDER_ENV[entry.provider]} to keychain.`,
      );
    }

    const { response, promptTokens } =
      entry.provider === 'ollama'
        ? await ollamaEmbeddings(entry, body, key)
        : await openaiEmbeddings(entry, body, key, BASES.openai);
    const cost = (promptTokens / 1000) * entry.cost_in;
    recordUsage(entry.id, promptTokens, 0, cost);
    return json(res, 200, response);
  }

  return fail(res, 404, 'not_found', 'Route not found.');
}

const server = createServer((req, res) => {
  const started = Date.now();
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const ms = Date.now() - started;
    const path = pathOf(req.url);
    process.stdout.write(
      JSON.stringify({
        t: new Date().toISOString(),
        svc: SERVICE,
        method: req.method,
        path,
        status: res.statusCode,
        ms,
      }) + '\n',
    );
    if (path !== '/healthz') {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      report(level, 'http_request', { method: req.method, path, status: res.statusCode, ms });
    }
  };
  res.on('finish', log);
  res.on('close', log);

  cors(res);
  route(req, res).catch((err) => {
    if (!res.headersSent) {
      fail(
        res,
        err.status || 500,
        err.code || 'internal_error',
        err.status ? err.message : 'Unexpected server error.',
      );
    } else {
      try {
        res.end();
      } catch {}
    }
    if (!err.status) {
      process.stderr.write(
        JSON.stringify({
          t: new Date().toISOString(),
          svc: SERVICE,
          level: 'error',
          event: 'unhandled_error',
          fields: { message: String(err && err.message) },
        }) + '\n',
      );
    }
  });
});

server.listen(PORT, () => {
  process.stdout.write(
    JSON.stringify({
      t: new Date().toISOString(),
      svc: SERVICE,
      level: 'info',
      event: 'listening',
      fields: { port: PORT },
    }) + '\n',
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

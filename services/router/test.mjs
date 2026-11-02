import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-router-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function reply(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const secrets = new Map();
let seenAnthropic = null;
let seenGemini = null;
let seenOllama = null;

const keychain = createHttpServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/v1\/secrets\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    const name = decodeURIComponent(match[1]);
    if (secrets.has(name)) return reply(res, 200, { name, value: secrets.get(name) });
    return reply(res, 404, { error: { code: 'secret_not_found', message: 'missing' } });
  }
  return reply(res, 404, { error: { code: 'not_found', message: 'nope' } });
});

const upstream = createHttpServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET') {
    return reply(res, 200, { data: [], models: [] });
  }

  const body = await readJson(req);

  if (path === '/openai/chat/completions' || path === '/openrouter/chat/completions') {
    if (body.model === 'gpt-4o') {
      return reply(res, 500, { error: { message: 'upstream exploded' } });
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"streamed"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    return reply(res, 200, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 123,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello from fake' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  if (path === '/anthropic/v1/messages') {
    seenAnthropic = body;
    return reply(res, 200, {
      id: 'msg_fake',
      model: body.model,
      content: [{ type: 'text', text: 'from anthropic' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  }

  if (path.startsWith('/gemini/v1beta/models/') && path.includes(':generateContent')) {
    seenGemini = body;
    return reply(res, 200, {
      candidates: [{ content: { parts: [{ text: 'from gemini' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
    });
  }

  if (path === '/ollama/api/chat') {
    seenOllama = body;
    return reply(res, 200, {
      model: body.model,
      message: { role: 'assistant', content: 'from ollama' },
      done: true,
      prompt_eval_count: 8,
      eval_count: 3,
    });
  }

  if (path === '/openai/embeddings') {
    return reply(res, 200, {
      object: 'list',
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: body.model,
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
  }

  if (path === '/ollama/api/embed') {
    return reply(res, 200, {
      model: body.model,
      embeddings: [[0.4, 0.5]],
      prompt_eval_count: 3,
    });
  }

  return reply(res, 404, { error: { message: `no fake route for ${path}` } });
});

const keychainPort = await listen(keychain);
const upstreamPort = await listen(upstream);
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(HERE, 'src', 'server.js')], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: String(port),
    VF_SERVICE_TOKEN: TOKEN,
    KEYCHAIN_URL: `http://127.0.0.1:${keychainPort}`,
    LENS_URL: '',
    VF_ROUTER_OPENAI_BASE_URL: `${upstreamBase}/openai`,
    VF_ROUTER_ANTHROPIC_BASE_URL: `${upstreamBase}/anthropic`,
    VF_ROUTER_GEMINI_BASE_URL: `${upstreamBase}/gemini`,
    VF_ROUTER_OPENROUTER_BASE_URL: `${upstreamBase}/openrouter`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => { output += d.toString(); });
child.stderr.on('data', (d) => { output += d.toString(); });

let checks = 0;
function ok(cond, message) {
  assert.ok(cond, message);
  checks += 1;
}
function approx(actual, expected, message, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${message} (got ${actual}, want ${expected})`);
  checks += 1;
}

async function call(method, path, { body, token = TOKEN } = {}) {
  const headers = {};
  if (token !== null) headers['x-vf-token'] = token;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('router did not become ready');
}

let failed = false;
try {
  await waitReady();

  const health = await call('GET', '/healthz', { token: null });
  ok(health.status === 200, 'health status');
  ok(health.data.service === 'router' && health.data.status === 'ok', 'health body');
  ok(health.data.version === '0.1.0', 'health version');
  ok(typeof health.data.uptime_s === 'number', 'health uptime');

  const noAuth = await call('GET', '/v1/models', { token: null });
  ok(noAuth.status === 401 && noAuth.data.error.code === 'unauthorized', 'models requires token');

  const root = await call('GET', '/');
  ok(root.status === 200 && root.data.service === 'router', 'banner');

  const preflight = await fetch(`${base}/v1/models`, { method: 'OPTIONS' });
  ok(preflight.status === 204, 'OPTIONS is 204');
  ok(preflight.headers.get('access-control-allow-origin') === '*', 'CORS origin');

  const models = await call('GET', '/v1/models');
  ok(models.status === 200, 'models status');
  ok(models.data.models.length >= 8, 'model catalog size');
  const mini = models.data.models.find((m) => m.id === 'gpt-4o-mini');
  ok(mini.provider === 'openai' && typeof mini.cost_per_1k_in === 'number' && typeof mini.cost_per_1k_out === 'number', 'model cost fields');

  const providersBefore = await call('GET', '/v1/health/providers');
  ok(providersBefore.status === 200 && providersBefore.data.providers.length === 5, 'providers listed');
  ok(providersBefore.data.providers.every((p) => p.configured === false && p.reachable === null), 'providers unconfigured before keys');

  const noProvider = await call('POST', '/v1/chat/completions', {
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(noProvider.status === 503 && noProvider.data.error.code === 'no_provider_configured', 'chat without provider 503');
  ok(noProvider.data.error.message.toLowerCase().includes('keychain'), '503 message mentions keychain');

  const noProviderEmbed = await call('POST', '/v1/embeddings', { body: { input: 'hello' } });
  ok(noProviderEmbed.status === 503 && noProviderEmbed.data.error.code === 'no_provider_configured', 'embeddings without provider 503');

  const unknownModel = await call('POST', '/v1/chat/completions', {
    body: { model: 'not-a-model', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(unknownModel.status === 400 && unknownModel.data.error.code === 'model_not_found', 'unknown model 400');

  const badMessages = await call('POST', '/v1/chat/completions', { body: { model: 'gpt-4o-mini' } });
  ok(badMessages.status === 400 && badMessages.data.error.code === 'invalid_messages', 'messages validated');

  const badStream = await call('POST', '/v1/chat/completions', {
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: 'yes' },
  });
  ok(badStream.status === 400 && badStream.data.error.code === 'invalid_stream', 'stream validated');

  const badMax = await call('POST', '/v1/chat/completions', {
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 },
  });
  ok(badMax.status === 400 && badMax.data.error.code === 'invalid_max_tokens', 'max_tokens validated');

  secrets.set('OPENAI_API_KEY', 'test-openai-key');
  secrets.set('ANTHROPIC_API_KEY', 'test-anthropic-key');
  secrets.set('GEMINI_API_KEY', 'test-gemini-key');
  secrets.set('OPENROUTER_API_KEY', 'test-openrouter-key');
  secrets.set('OLLAMA_URL', `${upstreamBase}/ollama`);

  const providersAfter = await call('GET', '/v1/health/providers');
  ok(providersAfter.data.providers.every((p) => p.configured === true), 'providers configured after keys');
  ok(providersAfter.data.providers.every((p) => p.reachable === true), 'providers reachable via fake upstream');

  const chat = await call('POST', '/v1/chat/completions', {
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 },
  });
  ok(chat.status === 200, 'openai chat status');
  ok(chat.data.object === 'chat.completion' && Array.isArray(chat.data.choices), 'openai chat shape');
  ok(chat.data.choices[0].message.content === 'hello from fake', 'openai chat content');
  ok(chat.data.usage.prompt_tokens === 10 && chat.data.usage.completion_tokens === 5, 'openai usage');
  ok(chat.data.vf.provider === 'openai', 'openai vf provider');
  approx(chat.data.vf.cost_usd, 0.0045, 'openai cost');
  ok(typeof chat.data.vf.latency_ms === 'number', 'openai latency');

  const anthropic = await call('POST', '/v1/chat/completions', {
    body: {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
    },
  });
  ok(anthropic.status === 200, 'anthropic chat status');
  ok(anthropic.data.choices[0].message.content === 'from anthropic', 'anthropic content mapped');
  ok(anthropic.data.choices[0].finish_reason === 'stop', 'anthropic finish reason mapped');
  ok(anthropic.data.usage.prompt_tokens === 11 && anthropic.data.usage.completion_tokens === 7, 'anthropic usage mapped');
  ok(anthropic.data.vf.provider === 'anthropic', 'anthropic vf provider');
  approx(anthropic.data.vf.cost_usd, 0.138, 'anthropic cost');
  ok(seenAnthropic.system === 'be nice', 'anthropic system extracted');
  ok(seenAnthropic.messages.length === 1 && seenAnthropic.messages[0].content === 'hi', 'anthropic messages translated');

  const gemini = await call('POST', '/v1/chat/completions', {
    body: {
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    },
  });
  ok(gemini.status === 200, 'gemini chat status');
  ok(gemini.data.choices[0].message.content === 'from gemini', 'gemini content mapped');
  ok(gemini.data.usage.prompt_tokens === 9 && gemini.data.usage.completion_tokens === 4, 'gemini usage mapped');
  ok(gemini.data.vf.provider === 'gemini', 'gemini vf provider');
  approx(gemini.data.vf.cost_usd, 0.0025, 'gemini cost');
  ok(seenGemini.systemInstruction.parts[0].text === 'be brief', 'gemini system translated');
  ok(seenGemini.contents[0].role === 'user' && seenGemini.contents[0].parts[0].text === 'hi', 'gemini contents translated');

  const openrouter = await call('POST', '/v1/chat/completions', {
    body: { model: 'openrouter/auto', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(openrouter.status === 200 && openrouter.data.vf.provider === 'openrouter', 'openrouter chat');
  approx(openrouter.data.vf.cost_usd, 0, 'openrouter cost unknown is 0');

  const ollama = await call('POST', '/v1/chat/completions', {
    body: { model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(ollama.status === 200, 'ollama chat status');
  ok(ollama.data.choices[0].message.content === 'from ollama', 'ollama content mapped');
  ok(ollama.data.usage.prompt_tokens === 8 && ollama.data.usage.completion_tokens === 3, 'ollama usage mapped');
  ok(seenOllama.stream === false, 'ollama non-stream request');

  const upstreamFailure = await call('POST', '/v1/chat/completions', {
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(upstreamFailure.status === 502 && upstreamFailure.data.error.code === 'provider_error', 'upstream failure 502');
  ok(upstreamFailure.data.error.message.includes('500'), 'provider error carries upstream status');

  const chatWithEmbeddingModel = await call('POST', '/v1/chat/completions', {
    body: { model: 'text-embedding-3-small', messages: [{ role: 'user', content: 'hi' }] },
  });
  ok(chatWithEmbeddingModel.status === 400 && chatWithEmbeddingModel.data.error.code === 'model_not_chat', 'embedding model rejected for chat');

  const embeddings = await call('POST', '/v1/embeddings', {
    body: { model: 'text-embedding-3-small', input: 'hello world' },
  });
  ok(embeddings.status === 200, 'embeddings status');
  ok(embeddings.data.object === 'list', 'embeddings object');
  ok(embeddings.data.data[0].embedding.length === 3 && embeddings.data.data[0].index === 0, 'embeddings data');
  ok(embeddings.data.model === 'text-embedding-3-small', 'embeddings model');
  ok(embeddings.data.usage.prompt_tokens === 4, 'embeddings usage');

  const defaultEmbeddings = await call('POST', '/v1/embeddings', { body: { input: 'hello' } });
  ok(defaultEmbeddings.status === 200 && defaultEmbeddings.data.model === 'text-embedding-3-small', 'default embedding model');

  const ollamaEmbeddings = await call('POST', '/v1/embeddings', {
    body: { model: 'nomic-embed-text', input: 'hello' },
  });
  ok(ollamaEmbeddings.status === 200 && ollamaEmbeddings.data.data[0].embedding[0] === 0.4, 'ollama embeddings');

  const unsupported = await call('POST', '/v1/embeddings', {
    body: { model: 'claude-3-5-sonnet-20241022', input: 'hello' },
  });
  ok(unsupported.status === 501 && unsupported.data.error.code === 'embeddings_unsupported', 'embeddings unsupported 501');

  const unknownEmbeddingModel = await call('POST', '/v1/embeddings', {
    body: { model: 'nope', input: 'hello' },
  });
  ok(unknownEmbeddingModel.status === 400 && unknownEmbeddingModel.data.error.code === 'model_not_found', 'embeddings unknown model');

  const badInput = await call('POST', '/v1/embeddings', { body: { input: 5 } });
  ok(badInput.status === 400 && badInput.data.error.code === 'invalid_input', 'embeddings input validated');

  const streamRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vf-token': TOKEN },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const streamText = await streamRes.text();
  ok(streamRes.status === 200, 'stream status');
  ok((streamRes.headers.get('content-type') || '').includes('text/event-stream'), 'stream content type');
  ok(streamText.includes('"content":"streamed"'), 'stream content proxied');
  ok(streamText.includes('[DONE]'), 'stream terminator proxied');

  const anthropicStream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vf-token': TOKEN },
    body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const anthropicText = await anthropicStream.text();
  ok(anthropicStream.status === 200, 'anthropic stream status');
  ok((anthropicStream.headers.get('content-type') || '').includes('text/event-stream'), 'anthropic stream type');
  ok(anthropicText.includes('from anthropic') && anthropicText.includes('[DONE]'), 'anthropic stream translated');

  const usage = await call('GET', '/v1/usage');
  ok(usage.status === 200, 'usage status');
  ok(usage.data.calls >= 8, 'usage call count');
  ok(usage.data.tokens_in >= 38, 'usage prompt tokens');
  ok(usage.data.tokens_out >= 19, 'usage completion tokens');
  ok(usage.data.cost_usd > 0, 'usage cost');
  ok(usage.data.by_model['gpt-4o-mini'].calls >= 2, 'usage by model');

  const known = await call('GET', '/v1/nope');
  ok(known.status === 404 && known.data.error.code === 'not_found', 'unknown route');
} catch (err) {
  failed = true;
  console.error(err);
  console.error('--- router output ---\n' + output);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  keychain.close();
  upstream.close();
}

if (failed) process.exit(1);
console.log(`router: green, ${checks} tests`);
process.exit(0);

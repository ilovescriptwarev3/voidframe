export class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.code = 'provider_error';
    this.status = 502;
  }
}

export const MODELS = [
  { id: 'gpt-4o', provider: 'openai', object: 'model' },
  { id: 'gpt-4o-mini', provider: 'openai', object: 'model' },
  { id: 'o4-mini', provider: 'openai', object: 'model' },
  { id: 'claude-sonnet-4-5', provider: 'anthropic', object: 'model' },
  { id: 'claude-opus-4-1', provider: 'anthropic', object: 'model' },
  { id: 'gemini-2.5-pro', provider: 'gemini', object: 'model' },
  { id: 'gemini-2.5-flash', provider: 'gemini', object: 'model' },
  { id: 'openrouter/auto', provider: 'openrouter', object: 'model' },
  { id: 'ollama/llama3.1', provider: 'ollama', object: 'model' },
];

const BASE_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};

const KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null,
};

const COSTS = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

export const PROVIDERS = Object.keys(BASE_DEFAULTS);

export function providerFor(model) {
  const name = String(model || '').toLowerCase();
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini')) return 'gemini';
  if (name.startsWith('openrouter/')) return 'openrouter';
  if (name.startsWith('ollama/')) return 'ollama';
  return 'openai';
}

export function baseUrl(provider) {
  const fromEnv = process.env[`${provider.toUpperCase()}_BASE_URL`];
  const base = fromEnv || BASE_DEFAULTS[provider] || BASE_DEFAULTS.openai;
  return String(base).replace(/\/+$/, '');
}

export function keyEnvName(provider) {
  return KEY_ENV[provider] || null;
}

export function requiresKey(provider) {
  return Boolean(KEY_ENV[provider]);
}

export function modelId(provider, model) {
  const name = String(model);
  if (provider === 'openrouter') return name.replace(/^openrouter\//i, '');
  if (provider === 'ollama') return name.replace(/^ollama\//i, '');
  return name;
}

export function costOf(model, promptTokens, completionTokens) {
  const table = COSTS[String(model)] || { input: 0, output: 0 };
  return (promptTokens / 1e6) * table.input + (completionTokens / 1e6) * table.output;
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function timeout() {
  return AbortSignal.timeout(Number(process.env.VF_ROUTER_TIMEOUT_MS || 60000));
}

async function postJson(provider, url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeout(),
    });
  } catch (err) {
    throw new ProviderError(`${provider} request failed: ${err.message}`);
  }
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const detail =
      (parsed && (parsed.error?.message || parsed.message || parsed.error)) ||
      text.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw new ProviderError(`${provider} returned ${res.status}: ${String(detail).slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ProviderError(`${provider} returned a non-JSON response.`);
  }
  return parsed;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.type === 'text' ? part.text : ''))
      .join('');
  }
  return '';
}

function normalizeOpenAi(parsed) {
  const choice = parsed.choices?.[0] || {};
  const content = flattenContent(choice.message?.content) || '';
  const usage = parsed.usage || {};
  return {
    content,
    finish_reason: choice.finish_reason || 'stop',
    prompt_tokens: Number(usage.prompt_tokens) || estimateTokens(''),
    completion_tokens: Number(usage.completion_tokens) || estimateTokens(content),
  };
}

function splitSystem(messages) {
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message.role === 'system') system.push(flattenContent(message.content));
    else rest.push(message);
  }
  return { system: system.join('\n'), messages: rest };
}

async function callOpenAiCompatible(provider, { model, messages, temperature, max_tokens, key }) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (provider === 'openrouter') {
    headers['http-referer'] = 'https://voidframe.local';
    headers['x-title'] = 'Voidframe';
  }
  const body = {
    model: modelId(provider, model),
    messages,
    stream: false,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;
  const parsed = await postJson(provider, `${baseUrl(provider)}/chat/completions`, headers, body);
  return normalizeOpenAi(parsed);
}

async function callAnthropic({ model, messages, temperature, max_tokens, key }) {
  const { system, messages: rest } = splitSystem(messages);
  const body = {
    model: modelId('anthropic', model),
    max_tokens: max_tokens || 1024,
    messages: rest.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: flattenContent(message.content),
    })),
  };
  if (system) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;
  const parsed = await postJson(
    'anthropic',
    `${baseUrl('anthropic')}/v1/messages`,
    {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
    },
    body,
  );
  const content = (parsed.content || [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
  const stop = parsed.stop_reason;
  const finish = stop === 'max_tokens' ? 'length' : stop === 'tool_use' ? 'tool_calls' : 'stop';
  return {
    content,
    finish_reason: finish,
    prompt_tokens: Number(parsed.usage?.input_tokens) || estimateTokens(JSON.stringify(messages)),
    completion_tokens: Number(parsed.usage?.output_tokens) || estimateTokens(content),
  };
}

async function callGemini({ model, messages, temperature, max_tokens, key }) {
  const { system, messages: rest } = splitSystem(messages);
  const contents = rest.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: flattenContent(message.content) }],
  }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (max_tokens !== undefined) generationConfig.maxOutputTokens = max_tokens;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  const id = modelId('gemini', model);
  const url = `${baseUrl('gemini')}/v1beta/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(key)}`;
  const parsed = await postJson('gemini', url, { 'content-type': 'application/json' }, body);
  const candidate = parsed.candidates?.[0] || {};
  const content = (candidate.content?.parts || [])
    .map((part) => part.text || '')
    .join('');
  const reason = candidate.finishReason;
  const finish = reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' ? 'content_filter' : 'stop';
  const usage = parsed.usageMetadata || {};
  return {
    content,
    finish_reason: finish,
    prompt_tokens: Number(usage.promptTokenCount) || estimateTokens(JSON.stringify(messages)),
    completion_tokens: Number(usage.candidatesTokenCount) || estimateTokens(content),
  };
}

export async function complete({ provider, model, messages, temperature, max_tokens, key }) {
  if (provider === 'anthropic') {
    return callAnthropic({ model, messages, temperature, max_tokens, key });
  }
  if (provider === 'gemini') {
    return callGemini({ model, messages, temperature, max_tokens, key });
  }
  return callOpenAiCompatible(provider, { model, messages, temperature, max_tokens, key });
}

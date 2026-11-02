export function routerBase() {
  return (process.env.ROUTER_URL || 'http://127.0.0.1:8089').replace(/\/+$/, '');
}

export async function routerComplete(body, { timeoutMs = 30000 } = {}) {
  const token = process.env.VF_SERVICE_TOKEN || 'dev-token-change-me';
  let res;
  try {
    res = await fetch(`${routerBase()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vf-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const error = new Error(`router unreachable: ${err.message}`);
    error.code = 'router_unavailable';
    error.status = 502;
    throw error;
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
      (parsed && (parsed.error?.message || parsed.error)) || text.slice(0, 200) || `HTTP ${res.status}`;
    const error = new Error(`router returned ${res.status}: ${String(detail).slice(0, 200)}`);
    error.code = (parsed && parsed.error?.code) || 'router_error';
    error.status = res.status;
    throw error;
  }
  return {
    ...parsed,
    content: parsed?.choices?.[0]?.message?.content ?? '',
    usage: parsed?.usage || {},
    provider: parsed?.provider || null,
    model: parsed?.model || body.model,
  };
}

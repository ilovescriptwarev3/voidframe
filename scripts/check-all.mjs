const services = [
  ['apex', 8088], ['forge', 8000], ['crawler', 3000], ['vault', 8085],
  ['router', 8089], ['lens', 8086], ['keychain', 8087], ['panel', 5173],
];

const rows = await Promise.all(services.map(async ([name, port]) => {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return { name, port, ok: res.ok && body.status === 'ok', ms: Date.now() - t0, version: body.version };
  } catch (e) {
    return { name, port, ok: false, ms: Date.now() - t0, version: '-' };
  }
}));

for (const r of rows) {
  console.log(`${r.ok ? '●' : '○'} ${r.name.padEnd(9)} :${String(r.port).padEnd(5)} ${r.ok ? 'up  ' : 'down'} ${String(r.ms).padStart(4)}ms  v${r.version}`);
}
process.exit(rows.every((r) => r.ok) ? 0 : 1);

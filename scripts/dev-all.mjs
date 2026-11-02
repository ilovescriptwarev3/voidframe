import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const services = [
  { name: 'lens', port: 8086 },
  { name: 'keychain', port: 8087 },
  { name: 'vault', port: 8085 },
  { name: 'router', port: 8089 },
  { name: 'forge', port: 8000 },
  { name: 'crawler', port: 3000 },
  { name: 'apex', port: 8088 },
  { name: 'panel', port: 5173 },
];

const env = { ...process.env };
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const colors = [36, 32, 33, 35, 34, 31, 96, 92];
const children = [];

services.forEach((svc, i) => {
  const entry = join(root, 'services', svc.name, 'src', 'server.js');
  if (!existsSync(entry)) {
    console.log(`\x1b[90m[${svc.name}] not built yet — skipping\x1b[0m`);
    return;
  }
  const c = spawn(process.execPath, [entry], {
    cwd: join(root, 'services', svc.name),
    env: { ...env, PORT: String(env.PORT && svc.name === 'panel' ? env.PORT : svc.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${colors[i % colors.length]}m[${svc.name}]\x1b[0m`;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${tag} ${l}\n`);
    });
  };
  pipe(c.stdout, process.stdout);
  pipe(c.stderr, process.stderr);
  c.on('exit', (code) => console.log(`${tag} exited (${code})`));
  children.push(c);
});

const stop = () => {
  children.forEach((c) => { try { c.kill('SIGTERM'); } catch {} });
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

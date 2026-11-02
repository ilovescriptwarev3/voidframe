import { spawn, spawnSync } from 'node:child_process';

const CAP = 64 * 1024;

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

export function runCommand({ cmd, cwd, timeoutS, env }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const isWin = process.platform === 'win32';
  const file = isWin ? 'cmd.exe' : 'sh';
  const args = isWin ? ['/c', cmd] : ['-c', cmd];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        windowsVerbatimArguments: isWin,
        detached: !isWin,
      });
    } catch (err) {
      resolve({
        exit_code: 1,
        stdout: '',
        stderr: String(err && err.message ? err.message : err),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        ms: Date.now() - t0,
        truncated: false,
      });
      return;
    }

    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (which, chunk) => {
      if (which === 'out') {
        const room = CAP - outBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        out.push(slice);
        outBytes += slice.length;
        if (chunk.length > room) truncated = true;
      } else {
        const room = CAP - errBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        errOut.push(slice);
        errBytes += slice.length;
        if (chunk.length > room) truncated = true;
      }
    };

    child.stdout.on('data', (c) => collect('out', c));
    child.stderr.on('data', (c) => collect('err', c));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutS) * 1000);

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const record = {
        exit_code: timedOut ? 124 : (typeof code === 'number' ? code : 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        ms: Date.now() - t0,
        truncated,
      };
      if (timedOut) record.error = 'timeout';
      if (spawnError && !record.stderr) record.stderr = spawnError;
      resolve(record);
    };

    child.on('error', (err) => finish(1, String(err && err.message ? err.message : err)));
    child.on('close', (code) => finish(code));
  });
}

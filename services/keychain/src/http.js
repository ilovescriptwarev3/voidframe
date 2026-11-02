const METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const HEADERS = 'content-type,x-vf-token,authorization';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', METHODS);
  res.setHeader('Access-Control-Allow-Headers', HEADERS);
}
export function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}
export function send(res, status, body) {
  if (status === 204 || body === undefined || body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  json(res, status, body);
}
export function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}
export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(httpError(413, 'payload_too_large', 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(httpError(400, 'invalid_json', 'Request body must be a JSON object.'));
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}
export function requireToken(req, res) {
  const expected = process.env.VF_SERVICE_TOKEN || 'dev-token-change-me';
  const got = req.headers['x-vf-token'];
  if (got && got === expected) return true;
  fail(res, 401, 'unauthorized', 'Missing or invalid x-vf-token header.');
  return false;
}

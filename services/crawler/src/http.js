const METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const HEADERS = 'content-type,x-vf-token,authorization';
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', METHODS);
  res.setHeader('Access-Control-Allow-Headers', HEADERS);
}
export function cors(res) {
  setCors(res);
}
export function json(res, status, body) {
  const data = JSON.stringify(body);
  setCors(res);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}
export function send(res, status, body) {
  if (status === 204 || body === undefined || body === null) {
    setCors(res);
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
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        rejectOnce(httpError(413, 'payload_too_large', 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectOnce);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(httpError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(httpError(400, 'invalid_json', 'Request body must be a JSON object.'));
      }
      resolve(parsed);
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

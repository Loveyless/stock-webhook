'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { setCorsHeaders, requireToken } = require('./auth');
const { dataDir, envInt, maxBody, readTokenRequired } = require('./config');
const { send, sendHtml, sendText } = require('./http');
const { decodeUtf8Strict, enforceRetention, writeBodyToFile } = require('./store');
const { extractPayloadText, extractPayloadTitle, renderIndexPage, renderViewPage } = require('./render/pages');
const { formatBytes, formatCnDate } = require('./render/utils');

const EMBEDDED_MOCK_HTML =
  typeof __STOCKHOOK_MOCK_HTML__ === 'string' && __STOCKHOOK_MOCK_HTML__.trim() ? __STOCKHOOK_MOCK_HTML__ : '';

function utcNowIso() {
  const iso = new Date().toISOString(); // 2026-01-29T06:18:00.000Z
  return `${iso.slice(0, 19)}+00:00`;
}

function utcNowStamp() {
  const d = new Date();
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${hh}${mm}${ss}Z`;
}

function invalidId(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (s.includes('..')) return true;
  if (s.includes('/') || s.includes('\\')) return true;
  return false;
}

async function handlePostWebhook(req, res, url) {
  setCorsHeaders(req, res);
  if (!requireToken(req, res, url)) return;

  const clHeader = req.headers['content-length'];
  let expectedLength = null;
  if (clHeader != null) {
    const s = String(clHeader).trim();
    if (!/^\d+$/.test(s)) {
      res.setHeader('Connection', 'close');
      sendText(res, 400, 'invalid content-length\n');
      return;
    }
    expectedLength = Number.parseInt(s, 10);
  }

  const limit = maxBody();
  if (expectedLength != null && expectedLength <= 0) {
    sendText(res, 400, 'empty body\n');
    return;
  }
  if (expectedLength != null && expectedLength > limit) {
    res.setHeader('Connection', 'close');
    sendText(res, 413, 'payload too large\n');
    return;
  }

  const ctRaw = String(req.headers['content-type'] || 'application/octet-stream');
  const contentType = ctRaw.split(';')[0].trim() || 'application/octet-stream';

  const now = utcNowStamp();
  const ident = crypto.randomBytes(6).toString('hex');
  const recordName = `${now}-${ident}.json`;
  const bodyName = `${now}-${ident}.body`;

  const dir = dataDir();
  await fs.promises.mkdir(dir, { recursive: true });

  const recordPath = path.join(dir, recordName);
  const bodyPath = path.join(dir, bodyName);
  const tmpBodyPath = `${bodyPath}.tmp`;
  const tmpRecordPath = `${recordPath}.tmp`;

  let writeResult;
  try {
    writeResult = await writeBodyToFile(req, tmpBodyPath, { maxBytes: limit, expectedLength });
  } catch (err) {
    try {
      await fs.promises.unlink(tmpBodyPath);
    } catch {
      // ignore
    }
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      res.setHeader('Connection', 'close');
      sendText(res, 413, 'payload too large\n');
      return;
    }
    sendText(res, 400, 'incomplete body\n');
    return;
  }

  if (writeResult.written <= 0) {
    try {
      await fs.promises.unlink(tmpBodyPath);
    } catch {
      // ignore
    }
    sendText(res, 400, 'empty body\n');
    return;
  }

  if (expectedLength != null && writeResult.written !== expectedLength) {
    try {
      await fs.promises.unlink(tmpBodyPath);
    } catch {
      // ignore
    }
    sendText(res, 400, 'incomplete body\n');
    return;
  }

  await fs.promises.rename(tmpBodyPath, bodyPath);

  let decodedBody = null;
  let bodyText = null;
  let bodyB64 = null;
  const preview = writeResult.preview;

  if ((contentType === 'application/json' || contentType === 'text/json') && preview.length) {
    try {
      decodedBody = JSON.parse(decodeUtf8Strict(preview));
    } catch {
      decodedBody = null;
      bodyText = preview.toString('utf8');
    }
  } else if (preview.length) {
    try {
      bodyText = decodeUtf8Strict(preview);
    } catch {
      bodyB64 = preview.toString('base64');
    }
  }

  const record = {
    received_at: utcNowIso(),
    remote_addr: (req.socket && req.socket.remoteAddress) || '',
    path: url.pathname,
    content_type: contentType,
    user_agent: String(req.headers['user-agent'] || ''),
    body_file: bodyName,
    body_size: writeResult.written,
    body_sha256: writeResult.bodySha256,
    preview_truncated: writeResult.written > preview.length,
    body_json: decodedBody,
    body_text: bodyText,
    body_b64: bodyB64,
  };

  await fs.promises.writeFile(tmpRecordPath, JSON.stringify(record, null, 2), 'utf8');
  await fs.promises.rename(tmpRecordPath, recordPath);

  await enforceRetention(dir);
  sendText(res, 200, `ok ${recordName}\n`);
}

async function handleGetMock(req, res, url) {
  if (readTokenRequired() && !requireToken(req, res, url)) return;

  const mockPath = path.join(__dirname, 'mock.html');
  let html = '';
  try {
    html = await fs.promises.readFile(mockPath, 'utf8');
  } catch {
    html = '';
  }
  if (!html.trim() && EMBEDDED_MOCK_HTML) html = EMBEDDED_MOCK_HTML;
  if (!html.trim()) {
    sendText(res, 500, 'failed to load mock page\n');
    return;
  }
  sendHtml(res, 200, html);
}

async function handleGetIndex(req, res, url) {
  if (readTokenRequired() && !requireToken(req, res, url)) return;

  const dir = dataDir();
  await fs.promises.mkdir(dir, { recursive: true });

  let files = [];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  files.sort().reverse();
  files = files.slice(0, 50);

  const records = [];
  for (const name of files) {
    const full = path.join(dir, name);
    let size = 0;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      size = 0;
    }

    let receivedAt = '';
    let title = '（无标题）';
    try {
      const record = JSON.parse(await fs.promises.readFile(full, 'utf8'));
      receivedAt = formatCnDate(String(record.received_at || ''));
      let payload = record.body_json;
      if (payload == null && record.body_text != null) payload = String(record.body_text || '');
      const { text } = extractPayloadText(payload);
      const { title: t } = extractPayloadTitle(payload, text);
      if (t) title = t;
    } catch {
      // ignore
    }

    records.push({ name, when: receivedAt, size: formatBytes(size), title });
  }

  sendHtml(res, 200, renderIndexPage(records));
}

async function handleGetView(req, res, url) {
  if (readTokenRequired() && !requireToken(req, res, url)) return;

  const name = String(url.searchParams.get('id') || '').trim();
  if (invalidId(name)) {
    sendText(res, 400, 'invalid id\n');
    return;
  }

  const dir = dataDir();
  const recordPath = path.join(dir, name);
  try {
    await fs.promises.access(recordPath, fs.constants.R_OK);
  } catch {
    sendText(res, 404, 'not found\n');
    return;
  }

  let record;
  try {
    record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
  } catch {
    sendText(res, 500, 'failed to read record\n');
    return;
  }

  sendHtml(res, 200, await renderViewPage(name, record, dir));
}

async function handleGetRaw(req, res, url) {
  if (readTokenRequired() && !requireToken(req, res, url)) return;

  const name = String(url.searchParams.get('id') || '').trim();
  if (invalidId(name)) {
    sendText(res, 400, 'invalid id\n');
    return;
  }

  const dir = dataDir();
  const recordPath = path.join(dir, name);
  try {
    await fs.promises.access(recordPath, fs.constants.R_OK);
  } catch {
    sendText(res, 404, 'not found\n');
    return;
  }

  let record;
  try {
    record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
  } catch {
    sendText(res, 500, 'failed to read record\n');
    return;
  }

  const bodyName = String(record.body_file || '').trim();
  if (!bodyName || bodyName.includes('..') || bodyName.includes('/') || bodyName.includes('\\')) {
    sendText(res, 404, 'no body\n');
    return;
  }

  const bodyPath = path.join(dir, bodyName);
  try {
    await fs.promises.access(bodyPath, fs.constants.R_OK);
  } catch {
    sendText(res, 404, 'no body\n');
    return;
  }

  let size = null;
  try {
    size = (await fs.promises.stat(bodyPath)).size;
  } catch {
    size = null;
  }

  const ctype = String(record.content_type || 'application/octet-stream').trim() || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Server', 'stockhook/1.0');
  res.setHeader('Content-Type', ctype.startsWith('text/') ? `${ctype}; charset=utf-8` : ctype);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${bodyName}"`);
  if (size != null) res.setHeader('Content-Length', String(size));
  fs.createReadStream(bodyPath, { highWaterMark: 1024 * 1024 }).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const start = Date.now();
    const remote = (req.socket && req.socket.remoteAddress) || '';

    res.on('finish', () => {
      const ms = Date.now() - start;
      const line = `${remote} - - [${new Date().toISOString()}] "${req.method} ${req.url} HTTP/${req.httpVersion}" ${res.statusCode} ${ms}ms`;
      process.stderr.write(`${line}\n`);
    });

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.setHeader('Connection', 'close');
      sendText(res, 400, 'bad request\n');
      return;
    }

    try {
      if (req.method === 'OPTIONS') {
        if (url.pathname === '/' || url.pathname === '/webhook' || url.pathname === '/hook') {
          setCorsHeaders(req, res);
          send(res, 204, 'text/plain; charset=utf-8', Buffer.alloc(0));
          return;
        }
        sendText(res, 404, 'not found\n');
        return;
      }

      if (req.method === 'GET') {
        if (url.pathname === '/health') {
          sendText(res, 200, 'ok\n');
          return;
        }
        if (url.pathname === '/mock' || url.pathname === '/mock.html') {
          await handleGetMock(req, res, url);
          return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          await handleGetIndex(req, res, url);
          return;
        }
        if (url.pathname === '/view') {
          await handleGetView(req, res, url);
          return;
        }
        if (url.pathname === '/raw') {
          await handleGetRaw(req, res, url);
          return;
        }
        sendText(res, 404, 'not found\n');
        return;
      }

      if (req.method === 'POST') {
        if (url.pathname !== '/' && url.pathname !== '/webhook' && url.pathname !== '/hook') {
          res.setHeader('Connection', 'close');
          sendText(res, 404, 'not found\n');
          return;
        }
        await handlePostWebhook(req, res, url);
        return;
      }

      res.setHeader('Connection', 'close');
      sendText(res, 404, 'not found\n');
    } catch {
      setCorsHeaders(req, res);
      res.setHeader('Connection', 'close');
      sendText(res, 500, 'internal server error\n');
    }
  });
}

function main() {
  const host = String(process.env.STOCKHOOK_HOST || '0.0.0.0').trim() || '0.0.0.0';
  const port = envInt('STOCKHOOK_PORT', 49554);
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });

  const server = createServer();
  server.listen(port, host, 1024, () => {
    process.stderr.write(`[stockhook] listening on http://${host}:${port}, data_dir=${dir}\n`);
  });
}

module.exports = { createServer, main };

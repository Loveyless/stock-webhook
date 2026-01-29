#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { TextDecoder } = require('util');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

function envInt(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

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

function htmlEscape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCnDate(isoString) {
  const s = String(isoString || '').trim();
  if (!s) return '';
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  const beijing = new Date(dt.getTime() + 8 * 60 * 60 * 1000);
  const y = beijing.getUTCFullYear();
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const d = String(beijing.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatBytes(num) {
  if (num < 0) return String(num);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getByPath(value, pathParts) {
  let cur = value;
  for (const key of pathParts) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key];
    } else {
      return null;
    }
  }
  return cur;
}

function firstNonEmptyLine(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (s) return s;
  }
  return '';
}

function extractTitleFromMarkdown(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

function extractPayloadText(payload) {
  const candidates = [
    { path: ['content'], label: 'content' },
    { path: ['message'], label: 'message' },
    { path: ['body'], label: 'body' },
    { path: ['text'], label: 'text' },
    { path: ['markdown', 'text'], label: 'markdown.text' },
    { path: ['markdown', 'content'], label: 'markdown.content' },
    { path: ['markdown'], label: 'markdown' },
    { path: ['data', 'text'], label: 'data.text' },
    { path: ['data', 'content'], label: 'data.content' },
  ];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const c of candidates) {
      const v = getByPath(payload, c.path);
      if (typeof v === 'string' && v.trim()) return { text: v, label: c.label };
    }
  }
  if (typeof payload === 'string' && payload.trim()) return { text: payload, label: 'raw' };
  return { text: '', label: '' };
}

function extractPayloadTitle(payload, bodyText) {
  const candidates = [
    { path: ['title'], label: 'title' },
    { path: ['subject'], label: 'subject' },
    { path: ['markdown', 'title'], label: 'markdown.title' },
    { path: ['data', 'title'], label: 'data.title' },
  ];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const c of candidates) {
      const v = getByPath(payload, c.path);
      if (typeof v === 'string' && v.trim()) return { title: v.trim(), source: c.label };
    }
  }

  const s = String(bodyText || '').trim();
  if (s) {
    const md = extractTitleFromMarkdown(s);
    if (md) return { title: md, source: 'derived' };
    const line = firstNonEmptyLine(s);
    if (line) return { title: line.slice(0, 120), source: 'derived' };
  }
  return { title: '未命名', source: 'derived' };
}

function mdInline(text) {
  let s = htmlEscape(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function mdRenderBasic(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];

  function flushParagraph(buf) {
    if (!buf.length) return;
    const s = buf.map((b) => b.trim()).filter(Boolean).join(' ');
    out.push(`<p>${mdInline(s)}</p>`);
    buf.length = 0;
  }

  let inCode = false;
  const codeBuf = [];
  const paraBuf = [];
  let listKind = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r?\n$/, '');

    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push('<pre><code>');
        out.push(htmlEscape(codeBuf.join('\n')));
        out.push('</code></pre>');
        codeBuf.length = 0;
        inCode = false;
      } else {
        flushParagraph(paraBuf);
        if (listKind) {
          out.push(`</${listKind}>`);
          listKind = null;
        }
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paraBuf);
      if (listKind) {
        out.push(`</${listKind}>`);
        listKind = null;
      }
      continue;
    }

    let m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flushParagraph(paraBuf);
      if (listKind) {
        out.push(`</${listKind}>`);
        listKind = null;
      }
      const level = m[1].length;
      out.push(`<h${level}>${mdInline(m[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(paraBuf);
      if (listKind) {
        out.push(`</${listKind}>`);
        listKind = null;
      }
      out.push('<hr />');
      continue;
    }

    m = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (m) {
      flushParagraph(paraBuf);
      if (listKind) {
        out.push(`</${listKind}>`);
        listKind = null;
      }
      out.push(`<blockquote>${mdInline(m[1].trim())}</blockquote>`);
      continue;
    }

    m = /^\s{0,3}(\d+)\.\s+(.+)$/.exec(line);
    if (m) {
      flushParagraph(paraBuf);
      if (listKind !== 'ol') {
        if (listKind) out.push(`</${listKind}>`);
        out.push('<ol>');
        listKind = 'ol';
      }
      out.push(`<li>${mdInline(m[2].trim())}</li>`);
      continue;
    }

    m = /^\s{0,3}[-*+]\s+(.+)$/.exec(line);
    if (m) {
      flushParagraph(paraBuf);
      if (listKind !== 'ul') {
        if (listKind) out.push(`</${listKind}>`);
        out.push('<ul>');
        listKind = 'ul';
      }
      out.push(`<li>${mdInline(m[1].trim())}</li>`);
      continue;
    }

    paraBuf.push(line);
  }

  if (inCode) {
    out.push('<pre><code>');
    out.push(htmlEscape(codeBuf.join('\n')));
    out.push('</code></pre>');
  }
  flushParagraph(paraBuf);
  if (listKind) out.push(`</${listKind}>`);
  return out.join('\n');
}

function dataDir() {
  return String(process.env.STOCKHOOK_DATA_DIR || '/root/stockhook/data').trim() || '/root/stockhook/data';
}

function maxBody() {
  return envInt('STOCKHOOK_MAX_BODY', 262144);
}

function previewLimit() {
  return envInt('STOCKHOOK_PREVIEW_BYTES', 262144);
}

function renderMaxBytes() {
  return envInt('STOCKHOOK_RENDER_MAX_BYTES', 2097152);
}

function maxRecords() {
  return envInt('STOCKHOOK_MAX_RECORDS', 15);
}

function readTokenRequired() {
  const v = String(process.env.STOCKHOOK_READ_TOKEN_REQUIRED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function getProvidedToken(req, url) {
  const headerToken = String(req.headers['x-stockhook-token'] || '').trim();
  if (headerToken) return headerToken;

  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  return String(url.searchParams.get('token') || '').trim();
}

function safeCompareToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function send(res, statusCode, contentType, bodyBuffer) {
  res.statusCode = statusCode;
  res.setHeader('Server', 'stockhook/1.0');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(bodyBuffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(bodyBuffer);
}

function sendText(res, statusCode, text) {
  send(res, statusCode, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

function sendHtml(res, statusCode, html) {
  send(res, statusCode, 'text/html; charset=utf-8', Buffer.from(html, 'utf8'));
}

function requireToken(req, res, url) {
  const expected = String(process.env.STOCKHOOK_TOKEN || '').trim();
  if (!expected) {
    sendText(res, 500, 'server token not configured\n');
    return false;
  }
  const provided = getProvidedToken(req, url);
  if (safeCompareToken(provided, expected)) return true;
  sendText(res, 401, 'unauthorized\n');
  return false;
}

function invalidId(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (s.includes('..')) return true;
  if (s.includes('/') || s.includes('\\')) return true;
  return false;
}

async function enforceRetention(dir) {
  const keep = maxRecords();
  if (keep <= 0) return;

  let names = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  names.sort().reverse();
  const stale = names.slice(keep);

  for (const recordName of stale) {
    const recordPath = path.join(dir, recordName);
    let bodyName = '';
    try {
      const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
      bodyName = String(record.body_file || '').trim();
    } catch {
      bodyName = '';
    }

    try {
      await fs.promises.unlink(recordPath);
    } catch {
      // ignore
    }

    if (!bodyName) continue;
    if (bodyName.includes('..') || bodyName.includes('/') || bodyName.includes('\\')) continue;
    const bodyPath = path.join(dir, bodyName);
    try {
      await fs.promises.unlink(bodyPath);
    } catch {
      // ignore
    }
  }
}

function decodeUtf8Strict(buf) {
  const dec = new TextDecoder('utf-8', { fatal: true });
  return dec.decode(buf);
}

async function writeBodyToFile(req, outPath, contentLength) {
  const hasher = crypto.createHash('sha256');
  let written = 0;
  const previewMax = previewLimit();
  const previewChunks = [];
  let previewBytes = 0;

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > contentLength) {
        callback(new Error('too much data'));
        return;
      }
      hasher.update(chunk);
      if (previewBytes < previewMax) {
        const take = Math.min(previewMax - previewBytes, chunk.length);
        previewChunks.push(chunk.subarray(0, take));
        previewBytes += take;
      }
      callback(null, chunk);
    },
  });

  await pipeline(req, tap, fs.createWriteStream(outPath, { flags: 'wx' }));
  return {
    written,
    bodySha256: hasher.digest('hex'),
    preview: Buffer.concat(previewChunks, previewBytes),
  };
}

async function readFileMax(filePath, maxBytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function renderIndexPage(records) {
  const rows = records.length
    ? records
        .map(
          (r) =>
            `<tr>` +
            `<td><a href="/view?id=${htmlEscape(r.name)}">${htmlEscape(r.title)}</a><div class="small mono">${htmlEscape(r.name)}</div></td>` +
            `<td class="mono">${htmlEscape(r.when)}</td>` +
            `<td class="mono" style="text-align:right">${htmlEscape(r.size)}</td>` +
            `</tr>`,
        )
        .join('\n')
    : `<tr><td colspan="3">暂无数据</td></tr>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stockhook</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans"; margin: 20px; color: #0f172a; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 8px; vertical-align: top; }
    th { text-align: left; color: #475569; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .small { font-size: 12px; color: #64748b; }
    .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  </style>
</head>
<body>
  <h1>Stockhook</h1>
  <table>
    <thead><tr><th>标题</th><th>日期(北京时间)</th><th style="text-align:right">大小</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function renderViewPage(name, record, dir) {
  const bodyName = String(record.body_file || '').trim();
  const bodyPath = bodyName ? path.join(dir, bodyName) : '';
  const bodySizeRaw = record.body_size;
  const bodySize =
    typeof bodySizeRaw === 'number'
      ? bodySizeRaw
      : /^\d+$/.test(String(bodySizeRaw || ''))
        ? Number.parseInt(String(bodySizeRaw), 10)
        : 0;
  const contentType = String(record.content_type || 'application/octet-stream').trim() || 'application/octet-stream';

  const noteParts = [];
  let payload = null;
  let fallbackText = '';

  const renderMax = renderMaxBytes();
  let canRenderFull = Boolean(bodyPath) && fs.existsSync(bodyPath) && (bodySize <= renderMax || bodySize <= 0);

  if (canRenderFull) {
    try {
      const raw = await readFileMax(bodyPath, renderMax);
      if (raw.length > renderMax) {
        canRenderFull = false;
        noteParts.push('内容过大，仅展示预览。');
      } else if (contentType === 'application/json' || contentType === 'text/json') {
        try {
          payload = JSON.parse(decodeUtf8Strict(raw));
        } catch {
          payload = null;
          fallbackText = raw.toString('utf8');
        }
      } else {
        fallbackText = raw.toString('utf8');
      }
    } catch {
      canRenderFull = false;
      noteParts.push('读取原始内容失败，仅展示预览。');
    }
  }

  if (!canRenderFull) {
    payload = record.body_json ?? null;
    if (payload == null && record.body_text != null) fallbackText = String(record.body_text || '');
    else if (payload == null && record.body_b64 != null) fallbackText = `[binary base64]\n${record.body_b64}`;
    if (record.preview_truncated) noteParts.push('预览已截断（仅展示前若干字节）。');
  }

  let { text: selectedText, label: selectedField } = extractPayloadText(payload);
  if (!selectedText && fallbackText) {
    selectedText = fallbackText;
    selectedField = 'raw';
  }

  const { title } = extractPayloadTitle(payload, selectedText);

  let contentHtml = '';
  if (selectedText) {
    contentHtml = mdRenderBasic(selectedText);
  } else if (payload != null) {
    contentHtml = `<pre><code>${htmlEscape(JSON.stringify(payload, null, 2))}</code></pre>`;
    noteParts.push('未找到可展示的正文字段，已显示原始 JSON。');
  } else {
    contentHtml = `<p class="small">无内容</p>`;
  }

  const note = noteParts.filter(Boolean).join(' ');
  const receivedAt = formatCnDate(String(record.received_at || ''));
  const sha = String(record.body_sha256 || '');
  const shaShort = sha ? sha.slice(0, 12) : '';
  const sizeLabel = bodySize ? formatBytes(bodySize) : '';

  const chips = [];
  if (receivedAt) chips.push(`日期(北京时间): ${receivedAt}`);
  if (sizeLabel) chips.push(`大小: ${sizeLabel}`);
  if (selectedField) chips.push(`字段: ${selectedField}`);
  if (shaShort) chips.push(`SHA256: ${shaShort}`);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} - Stockhook</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans"; margin: 20px; color: #0f172a; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .small { font-size: 12px; color: #64748b; }
    .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1020; color: #e6edf3; padding: 12px; border-radius: 10px; overflow-x: auto; }
    code { background: #eef2ff; padding: 2px 6px; border-radius: 8px; }
    blockquote { margin: 10px 0; padding: 10px 12px; background: #f8fafc; border-left: 4px solid rgba(6, 182, 212, 0.45); color: #334155; border-radius: 10px; }
    hr { border: 0; border-top: 1px solid #e2e8f0; margin: 14px 0; }
  </style>
</head>
<body>
  <div><a href="/">&larr; 返回</a> | <a href="/raw?id=${htmlEscape(name)}">下载原文</a></div>
  <h1>${htmlEscape(title)}</h1>
  <div class="small mono">${htmlEscape(chips.join('  |  '))}</div>
  <div class="small">${htmlEscape(note)}</div>
  <hr />
  <div>${contentHtml}</div>
  <hr />
  <div class="small mono">${htmlEscape(name)}</div>
</body>
</html>
`;
}

async function handlePostWebhook(req, res, url) {
  if (!requireToken(req, res, url)) return;

  const clHeader = req.headers['content-length'];
  let contentLength = 0;
  if (clHeader != null) {
    const s = String(clHeader).trim();
    if (!/^\d+$/.test(s)) {
      sendText(res, 400, 'invalid content-length\n');
      req.destroy();
      return;
    }
    contentLength = Number.parseInt(s, 10);
  }

  if (contentLength <= 0) {
    sendText(res, 400, 'empty body\n');
    req.destroy();
    return;
  }
  if (contentLength > maxBody()) {
    sendText(res, 413, 'payload too large\n');
    req.destroy();
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
    writeResult = await writeBodyToFile(req, tmpBodyPath, contentLength);
  } catch {
    try {
      await fs.promises.unlink(tmpBodyPath);
    } catch {
      // ignore
    }
    sendText(res, 400, 'incomplete body\n');
    req.destroy();
    return;
  }

  if (writeResult.written !== contentLength) {
    try {
      await fs.promises.unlink(tmpBodyPath);
    } catch {
      // ignore
    }
    sendText(res, 400, 'incomplete body\n');
    req.destroy();
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
    body_size: contentLength,
    body_sha256: writeResult.bodySha256,
    preview_truncated: contentLength > preview.length,
    body_json: decodedBody,
    body_text: bodyText,
    body_b64: bodyB64,
  };

  await fs.promises.writeFile(tmpRecordPath, JSON.stringify(record, null, 2), 'utf8');
  await fs.promises.rename(tmpRecordPath, recordPath);

  await enforceRetention(dir);
  sendText(res, 200, `ok ${recordName}\n`);
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
      sendText(res, 400, 'bad request\n');
      req.destroy();
      return;
    }

    try {
      if (req.method === 'GET') {
        if (url.pathname === '/health') {
          sendText(res, 200, 'ok\n');
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
        if (url.pathname !== '/webhook' && url.pathname !== '/hook') {
          sendText(res, 404, 'not found\n');
          req.destroy();
          return;
        }
        await handlePostWebhook(req, res, url);
        return;
      }

      sendText(res, 404, 'not found\n');
      req.destroy();
    } catch {
      sendText(res, 500, 'internal server error\n');
      req.destroy();
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

module.exports = { createServer };

if (require.main === module) main();


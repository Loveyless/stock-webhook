'use strict';

const fs = require('fs');
const path = require('path');

const { renderMaxBytes } = require('../config');
const { decodeUtf8Strict, readFileMax } = require('../store');
const { extractTitleFromMarkdown, renderMarkdownWithAnchors } = require('./markdown');
const { formatBytes, formatCnDate, firstNonEmptyLine, getByPath, htmlEscape } = require('./utils');

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
  <title>AI股票助手</title>
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
  <h1>AI股票助手</h1>
  <div class="small">作者 <a href="mailto:loveyless@126.com">loveyless@126.com</a></div>
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
  let tocHtml = '';
  let hasToc = false;
  if (selectedText) {
    const rendered = renderMarkdownWithAnchors(selectedText);
    contentHtml = rendered.html;
    const toc = rendered.headings.filter((h) => h && h.level === 2 && h.title && h.id);
    if (toc.length) {
      tocHtml = `<aside class="toc" id="toc"><div class="toc-head"><div class="toc-title">目录</div><button type="button" class="toc-close" aria-label="关闭目录">关闭</button></div><nav class="toc-links">${toc
        .map((h) => `<a href="#${htmlEscape(h.id)}">${htmlEscape(h.title)}</a>`)
        .join('\n')}</nav></aside>`;
      hasToc = true;
    }
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

  const tocToggleHtml = hasToc
    ? `<button type="button" class="toc-toggle" aria-controls="toc" aria-expanded="false">目录</button>`
    : '';

  const mainHtml =
    `<div class="topbar"><div class="topbar-links"><a href="/">&larr; 返回</a> | <a href="/raw?id=${htmlEscape(name)}">下载原文</a></div>${tocToggleHtml}</div>` +
    `<h1>${htmlEscape(title)}</h1>` +
    `<div class="small mono">${htmlEscape(chips.join('  |  '))}</div>` +
    `<div class="small">${htmlEscape(note)}</div>` +
    `<hr />` +
    `<div>${contentHtml}</div>` +
    `<hr />` +
    `<div class="small mono">${htmlEscape(name)}</div>`;

  const bodyHtml = hasToc
    ? `<div class="page">${tocHtml}<main class="main">${mainHtml}</main></div><div class="toc-backdrop" aria-hidden="true"></div>`
    : `<main class="main">${mainHtml}</main>`;

  const scriptHtml = hasToc
    ? `<script>(function(){const html=document.documentElement;const toggle=document.querySelector('.toc-toggle');const toc=document.getElementById('toc');const closeBtn=document.querySelector('.toc-close');const backdrop=document.querySelector('.toc-backdrop');if(!toggle||!toc)return;function setOpen(open){html.classList.toggle('toc-open',open);toggle.setAttribute('aria-expanded',open?'true':'false');}toggle.addEventListener('click',function(){setOpen(!html.classList.contains('toc-open'));});if(closeBtn)closeBtn.addEventListener('click',function(){setOpen(false);});if(backdrop)backdrop.addEventListener('click',function(){setOpen(false);});toc.addEventListener('click',function(e){const a=e.target&&e.target.closest?e.target.closest('a[href^=\"#\"]'):null;if(!a)return;setTimeout(function(){setOpen(false);},0);});document.addEventListener('keydown',function(e){if(e&&e.key==='Escape')setOpen(false);});window.addEventListener('resize',function(){if(window.innerWidth>500)setOpen(false);});})();</script>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} - Stockhook</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans"; margin: 0; color: #0f172a; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .small { font-size: 12px; color: #64748b; }
    .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1020; color: #e6edf3; padding: 12px; border-radius: 10px; overflow-x: auto; }
    code { background: #eef2ff; padding: 2px 6px; border-radius: 8px; }
    pre code { background: transparent; padding: 0; border-radius: 0; }
    blockquote { margin: 10px 0; padding: 10px 12px; background: #f8fafc; border-left: 4px solid rgba(6, 182, 212, 0.45); color: #334155; border-radius: 10px; }
    hr { border: 0; border-top: 1px solid #e2e8f0; margin: 14px 0; }
    h1, h2, h3, h4, h5, h6 { scroll-margin-top: 80px; }
    .page { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
    .main { min-width: 0; padding: 20px; }
    .topbar { position: sticky; top: 0; z-index: 30; background: #ffffff; padding: 10px 0; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .toc { position: sticky; top: 0; height: 100vh; overflow-y: auto; box-sizing: border-box; border-right: 1px solid #e2e8f0; padding: 16px; background: #ffffff; }
    .toc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .toc-title { font-size: 12px; color: #475569; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 8px; }
    .toc-links a { display: block; padding: 4px 0; color: #334155; }
    .toc-links a:hover { color: #4f46e5; }
    .toc-toggle { display: none; appearance: none; border: 1px solid #e2e8f0; background: #ffffff; color: #0f172a; border-radius: 10px; padding: 6px 10px; cursor: pointer; }
    .toc-close { display: none; appearance: none; border: 1px solid #e2e8f0; background: #ffffff; color: #0f172a; border-radius: 10px; padding: 6px 10px; cursor: pointer; }
    .toc-backdrop { display: none; }
    @media (max-width: 500px) {
      .page { grid-template-columns: 1fr; }
      .toc-toggle { display: inline-flex; }
      .toc-close { display: inline-flex; }
      .toc { position: fixed; top: 0; left: 0; height: 100vh; width: min(86vw, 320px); transform: translateX(-110%); transition: transform 0.18s ease; border-right: 1px solid #e2e8f0; border-bottom: 0; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.22); z-index: 50; }
      .toc-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 40; }
      .toc-open .toc { transform: translateX(0); }
      .toc-open .toc-backdrop { display: block; }
      .toc-open body { overflow: hidden; }
      .main { padding: 16px; }
    }
  </style>
</head>
<body>
  ${bodyHtml}
  ${scriptHtml}
</body>
</html>
`;
}

module.exports = {
  extractPayloadText,
  extractPayloadTitle,
  renderIndexPage,
  renderViewPage,
};

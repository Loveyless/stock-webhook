'use strict';

const { htmlEscape } = require('./utils');

function extractTitleFromMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s{0,3}#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const m = /^\s{0,3}##\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

function slugifyHeading(text) {
  let s = String(text || '').trim().toLowerCase();
  if (!s) return '';
  try {
    s = s.normalize('NFKC');
  } catch {
    // ignore
  }
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/g, '');
  return s;
}

function allocateHeadingId(level, title, usedIds) {
  const slug = slugifyHeading(title) || `section-${level}`;
  const base = `h${level}-${slug}`;
  let id = base;
  let n = 2;
  while (usedIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  usedIds.add(id);
  return id;
}

function mdInline(text) {
  let s = htmlEscape(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function renderMarkdownWithAnchors(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const headings = [];
  const usedHeadingIds = new Set();

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
      const title = m[2].trim();
      const id = allocateHeadingId(level, title, usedHeadingIds);
      headings.push({ level, title, id });
      out.push(`<h${level} id="${htmlEscape(id)}">${mdInline(title)}</h${level}>`);
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
  return { html: out.join('\n'), headings };
}

function mdRenderBasic(text) {
  return renderMarkdownWithAnchors(text).html;
}

module.exports = {
  extractTitleFromMarkdown,
  mdRenderBasic,
  renderMarkdownWithAnchors,
};

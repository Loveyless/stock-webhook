'use strict';

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

module.exports = {
  htmlEscape,
  formatCnDate,
  formatBytes,
  getByPath,
  firstNonEmptyLine,
};


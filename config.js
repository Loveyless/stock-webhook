'use strict';

const path = require('path');

function envInt(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function dataDir() {
  const v = String(process.env.STOCKHOOK_DATA_DIR || '').trim();
  if (v) return path.resolve(v);
  return path.join(__dirname, 'data');
}

function maxBody() {
  return envInt('STOCKHOOK_MAX_BODY', 10 * 1024 * 1024);
}

function previewLimit() {
  return envInt('STOCKHOOK_PREVIEW_BYTES', 500 * 1024);
}

function renderMaxBytes() {
  return envInt('STOCKHOOK_RENDER_MAX_BYTES', 10 * 1024 * 1024);
}

function maxRecords() {
  return envInt('STOCKHOOK_MAX_RECORDS', 100);
}

function readTokenRequired() {
  const v = String(process.env.STOCKHOOK_READ_TOKEN_REQUIRED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

module.exports = {
  envInt,
  dataDir,
  maxBody,
  previewLimit,
  renderMaxBytes,
  maxRecords,
  readTokenRequired,
};

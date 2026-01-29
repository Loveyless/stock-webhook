'use strict';

const crypto = require('crypto');

const { sendText } = require('./http');

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

function setCorsHeaders(req, res) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-stockhook-token');
  res.setHeader('Access-Control-Max-Age', '600');
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

module.exports = {
  getProvidedToken,
  safeCompareToken,
  setCorsHeaders,
  requireToken,
};


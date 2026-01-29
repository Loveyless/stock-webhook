'use strict';

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

module.exports = { send, sendText, sendHtml };


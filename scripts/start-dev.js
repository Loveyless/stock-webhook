#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { createServer } = require('../stockhook');
const rootDir = path.resolve(__dirname, '..');

if (!String(process.env.STOCKHOOK_TOKEN || '').trim()) process.env.STOCKHOOK_TOKEN = '123';
if (!String(process.env.STOCKHOOK_HOST || '').trim()) process.env.STOCKHOOK_HOST = '127.0.0.1';

const host = String(process.env.STOCKHOOK_HOST || '127.0.0.1').trim() || '127.0.0.1';
const portRaw = String(process.env.STOCKHOOK_PORT || '').trim();
const port = /^\d+$/.test(portRaw) ? Number.parseInt(portRaw, 10) : 49554;
const dir = path.join(rootDir, 'data');

fs.mkdirSync(dir, { recursive: true });

const server = createServer();
server.listen(port, host, 1024, () => {
  process.stderr.write(`[stockhook] listening on http://${host}:${port}, data_dir=${dir}\n`);
});

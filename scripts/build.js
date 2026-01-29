#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const entry = path.join(rootDir, 'stockhook.js');
  const outfile = path.join(distDir, 'stockhook.js');

  await fs.promises.mkdir(distDir, { recursive: true });

  const mockPath = path.join(rootDir, 'mock.html');
  let mockHtml = '';
  try {
    mockHtml = await fs.promises.readFile(mockPath, 'utf8');
  } catch {
    mockHtml = '';
  }
  if (!mockHtml.trim()) {
    throw new Error('mock.html is missing or empty');
  }

  const esbuild = require('esbuild');

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node18'],
    sourcemap: false,
    legalComments: 'none',
    define: {
      __STOCKHOOK_MOCK_HTML__: JSON.stringify(mockHtml),
    },
  });

  try {
    await fs.promises.chmod(outfile, 0o755);
  } catch {
  }

  process.stderr.write(`[build] wrote ${path.relative(rootDir, outfile)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[build] failed: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});

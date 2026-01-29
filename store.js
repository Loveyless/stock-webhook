'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { maxRecords, previewLimit } = require('./config');

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

async function writeBodyToFile(req, outPath, options) {
  const maxBytes = options && Number.isFinite(options.maxBytes) ? options.maxBytes : 0;
  let expectedLength = null;
  if (options && Object.prototype.hasOwnProperty.call(options, 'expectedLength')) expectedLength = options.expectedLength;
  if (expectedLength != null && !Number.isFinite(expectedLength)) expectedLength = null;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('invalid maxBytes');

  const hasher = crypto.createHash('sha256');
  let written = 0;
  const previewMax = previewLimit();
  const previewChunks = [];
  let previewBytes = 0;

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        const err = new Error('payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        callback(err);
        return;
      }
      if (expectedLength != null && written > expectedLength) {
        const err = new Error('too much data');
        err.code = 'TOO_MUCH_DATA';
        callback(err);
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

module.exports = {
  enforceRetention,
  decodeUtf8Strict,
  writeBodyToFile,
  readFileMax,
};


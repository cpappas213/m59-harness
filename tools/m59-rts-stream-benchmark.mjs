#!/usr/bin/env node
// Read-only latency/throughput probe for the native RTS stream.

import net from 'node:net';
import process from 'node:process';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const host = option('--host', '127.0.0.1');
if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('native gateway must be loopback');
const port = Number(option('--port', '8911'));
const agents = option('--agents', 't1,t2,t3,t4,t5');
if (!/^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/.test(agents)) throw new Error('invalid agent list');
const wanted = Math.max(2, Math.min(200, Number(option('--frames', '25')) || 25));
const timeoutMs = Math.max(1000, Math.min(60000, Number(option('--timeout-ms', '15000')) || 15000));

const socket = net.createConnection({ host, port });
socket.setNoDelay(true);
const connectedAt = performance.now();
let buffer = Buffer.alloc(0);
const frames = [];
let bytes = 0;
const timeout = setTimeout(() => socket.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

socket.on('connect', () => socket.write(`M59SUB\t1\t${agents}\n`));
socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const newline = buffer.indexOf(10);
    if (newline < 0) break;
    const fields = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '').split('\t');
    if (fields[0] === 'M59ERROR') throw new Error(decodeURIComponent(fields[2] || 'gateway error'));
    if (fields.length !== 3 || fields[0] !== 'M59FRAME' || fields[1] !== '1') {
      throw new Error('invalid native frame header');
    }
    const length = Number(fields[2]);
    if (!Number.isInteger(length) || length < 1 || length > 8 * 1024 * 1024) {
      throw new Error('invalid native frame length');
    }
    if (buffer.length < newline + 1 + length) break;
    const payload = buffer.subarray(newline + 1, newline + 1 + length);
    buffer = buffer.subarray(newline + 1 + length);
    const firstLineEnd = payload.indexOf(10);
    const header = payload.subarray(0, firstLineEnd).toString('utf8').split('\t');
    if (header[0] !== 'M59RTS' || !['1', '2', '3', '4', '5', '6'].includes(header[1])) {
      throw new Error('invalid snapshot payload');
    }
    frames.push({ at: performance.now(), length, sequence: decodeURIComponent(header[2]) });
    bytes += length;
    if (frames.length >= wanted) socket.end();
  }
});

await new Promise((resolve, reject) => {
  socket.on('end', resolve);
  socket.on('close', () => frames.length >= wanted && resolve());
  socket.on('error', reject);
});
clearTimeout(timeout);
if (frames.length < wanted) throw new Error(`stream ended after ${frames.length}/${wanted} frames`);

const intervals = frames.slice(1).map((frame, index) => frame.at - frames[index].at);
const elapsed = frames[frames.length - 1].at - frames[0].at;
const firstMs = frames[0].at - connectedAt;
console.log(JSON.stringify({
  agents: agents.split(',').length,
  frames: frames.length,
  first_frame_ms: Number(firstMs.toFixed(1)),
  interval_ms: {
    min: Number(Math.min(...intervals).toFixed(1)),
    p50: Number(percentile(intervals, 0.50).toFixed(1)),
    p95: Number(percentile(intervals, 0.95).toFixed(1)),
    max: Number(Math.max(...intervals).toFixed(1)),
  },
  payload_kib_per_second: Number((bytes / 1024 / (elapsed / 1000)).toFixed(1)),
  average_frame_bytes: Math.round(bytes / frames.length),
  first_sequence: frames[0].sequence,
  last_sequence: frames[frames.length - 1].sequence,
}, null, 2));

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_SNAPSHOT_BYTES } from './savedStreams.mjs';

export async function readPrivateJson(file) {
  try {
    if ((await fs.stat(file)).size > MAX_SNAPSHOT_BYTES) throw new Error('Private snapshot too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writePrivateJson(file, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error('Private snapshot too large');
  try { if (await fs.readFile(file, 'utf8') === text) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
  return true;
}

export async function readConditionalSnapshot(source, etag, request = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let reader;
  let response;
  try {
    response = await request(source.url, { headers: { ...source.headers, ...(etag ? { 'If-None-Match': etag } : {}) }, signal: controller.signal, redirect: 'error' });
    if (response.status === 304) return { unchanged: true };
    if (!response.ok) throw new Error('Private backup unavailable');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_SNAPSHOT_BYTES) throw new Error('Private snapshot too large');
      chunks.push(chunk.value);
    }
    return { snapshot: JSON.parse(Buffer.concat(chunks, size).toString('utf8')), etag: response.headers.get('etag') || '' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_SNAPSHOT_BYTES } from './savedStreams.mjs';

const exec = promisify(execFile);
const runGitHub = async args => (await exec('gh', args, { timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true })).stdout.trim();

function validatePath(repository, filePath) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || filePath.startsWith('/') || filePath.split('/').some(p => !p || p === '..' || p === '.') || !/^[A-Za-z0-9_./-]+$/.test(filePath)) throw new Error('Invalid private repository path');
}

const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export async function readPrivateSnapshot({ repository, filePath = 'resolved-streams.json', run = runGitHub }) {
  validatePath(repository, filePath);
  if ((await run(['api', `repos/${repository}`, '--jq', '.private'])).trim() !== 'true') throw new Error('Saved addresses require a private repository');
  let sha;
  try { sha = (await run(['api', `repos/${repository}/contents/${filePath}`, '--jq', '.sha'])).trim(); }
  catch (error) { if (/\(HTTP 404\)/.test(error.stderr || '')) return { sha: null, snapshot: null }; throw new Error('Cannot read private snapshot revision'); }
  // Git blobs preserve exact bytes, including trailing newlines, and support
  // files larger than the Contents API's inline base64 limit.
  const blob = JSON.parse(await run(['api', `repos/${repository}/git/blobs/${sha}`]));
  if (blob.encoding !== 'base64') throw new Error('Invalid private snapshot encoding');
  const bytes = Buffer.from(blob.content, 'base64');
  if (bytes.length > MAX_SNAPSHOT_BYTES || blobSha(bytes) !== sha) throw new Error('Invalid private snapshot contents');
  return { sha, snapshot: JSON.parse(bytes.toString('utf8')) };
}

export async function uploadPrivateSnapshot({ repository, snapshot, filePath = 'resolved-streams.json', expectedSha, run = runGitHub }) {
  validatePath(repository, filePath);
  if ((await run(['api', `repos/${repository}`, '--jq', '.private'])).trim() !== 'true') throw new Error('Saved addresses require a private repository');
  let sha;
  try { sha = (await run(['api', `repos/${repository}/contents/${filePath}`, '--jq', '.sha'])).trim(); }
  catch (error) { if (!/\(HTTP 404\)/.test(error.stderr || '')) throw new Error('Cannot read private snapshot revision'); }
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot too large');
  if (sha === blobSha(bytes)) return null;
  if (expectedSha !== undefined && (sha || null) !== expectedSha) throw new Error('Private snapshot changed during sync; rerun to merge it safely');
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'tesla-sync-'));
  try {
    const payload = path.join(directory, 'request.json');
    await fs.writeFile(payload, JSON.stringify({ message: 'Update changed IPTV backup records', content: bytes.toString('base64'), ...(sha ? { sha } : {}) }), { mode: 0o600 });
    const response = JSON.parse(await run(['api', '--method', 'PUT', `repos/${repository}/contents/${filePath}`, '--input', payload]));
    return response.commit?.sha || null;
  } finally {
    const actual = await fs.realpath(directory);
    const relative = path.relative(parent, actual);
    if (path.dirname(relative) !== '.' || !path.basename(relative).startsWith('tesla-sync-')) throw new Error('Invalid temporary directory');
    await fs.rm(actual, { recursive: true, force: true });
  }
}

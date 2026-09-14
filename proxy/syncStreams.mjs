import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const runGitHub = async args => (await exec('gh', args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })).stdout.trim();

export async function uploadPrivateSnapshot({ repository, snapshot, filePath = 'resolved-streams.json', run = runGitHub }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || filePath.startsWith('/') || filePath.split('/').some(p => !p || p === '..' || p === '.') || !/^[A-Za-z0-9_./-]+$/.test(filePath)) throw new Error('Invalid private repository path');
  if ((await run(['api', `repos/${repository}`, '--jq', '.private'])).trim() !== 'true') throw new Error('Saved addresses require a private repository');
  let sha;
  try { sha = (await run(['api', `repos/${repository}/contents/${filePath}`, '--jq', '.sha'])).trim(); }
  catch (error) { if (!/\(HTTP 404\)/.test(error.stderr || '')) throw new Error('Cannot read private snapshot revision'); }
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'tesla-sync-'));
  try {
    const payload = path.join(directory, 'request.json');
    await fs.writeFile(payload, JSON.stringify({ message: 'Refresh private saved stream addresses', content: Buffer.from(JSON.stringify(snapshot)).toString('base64'), ...(sha ? { sha } : {}) }), { mode: 0o600 });
    const response = JSON.parse(await run(['api', '--method', 'PUT', `repos/${repository}/contents/${filePath}`, '--input', payload]));
    return response.commit?.sha || null;
  } finally {
    const actual = await fs.realpath(directory);
    const relative = path.relative(parent, actual);
    if (path.dirname(relative) !== '.' || !path.basename(relative).startsWith('tesla-sync-')) throw new Error('Invalid temporary directory');
    await fs.rm(actual, { recursive: true, force: true });
  }
}

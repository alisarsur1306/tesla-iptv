// One-time/private catalogue refresh. No persistent local server is required.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as request } from 'undici';
import { SavedStreams, accountScope, snapshotFromCatalogue } from '../proxy/savedStreams.mjs';
import { uploadPrivateSnapshot } from '../proxy/syncStreams.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = option('--directory') || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'TeslaIPTV');
const dispatcher = new Agent({ connect: { family: 4, timeout: 5000 }, allowH2: false });
try {
  const config = process.env.XTREAM_SERVER && process.env.XTREAM_USERNAME && process.env.XTREAM_PASSWORD
    ? { server: process.env.XTREAM_SERVER, username: process.env.XTREAM_USERNAME, password: process.env.XTREAM_PASSWORD }
    : JSON.parse(await fs.readFile(option('--config') || path.join(project, 'public', 'config.json'), 'utf8'));
  const endpoint = new URL('/player_api.php', config.server);
  for (const key of ['username', 'password']) endpoint.searchParams.set(key, config[key]);
  endpoint.searchParams.set('action', 'get_live_streams');
  let channels;
  if (option('--catalogue')) channels = JSON.parse(await fs.readFile(option('--catalogue'), 'utf8'));
  else {
    const response = await request(endpoint, { dispatcher, signal: AbortSignal.timeout(25000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Provider catalogue unavailable'); }
    channels = await response.json();
  }
  if (!Array.isArray(channels)) throw new Error('Invalid provider catalogue');
  const store = new SavedStreams({ directory, scope: accountScope(config) });
  const discovered = snapshotFromCatalogue(channels, config);
  await store.merge(discovered);
  const snapshot = await store.snapshot();
  await store.flush();
  const output = path.join(directory, 'resolved-streams.json');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(output, JSON.stringify(snapshot), { mode: 0o600 });
  console.log(`Saved ${discovered.entries.length} catalogue addresses privately. Their current playback validity is checked when opened.`);
  console.log(`Snapshot: ${output}`);
  const repository = option('--repository');
  if (repository) {
    await uploadPrivateSnapshot({ repository, snapshot, filePath: option('--path') || 'resolved-streams.json' });
    console.log('Private backup updated. No local process needs to remain running.');
  }
} catch (error) {
  console.error('Stream sync failed. Check the provider connection, local account configuration and private GitHub repository access.');
  const code = error.cause?.code || error.code || error.name;
  if (/^[A-Za-z0-9_]{1,64}$/.test(code || '')) console.error(`Failure type: ${code}`);
  process.exitCode = 1;
} finally { await dispatcher.destroy(); }

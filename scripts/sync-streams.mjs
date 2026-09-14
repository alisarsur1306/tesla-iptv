// One-time/private catalogue refresh. No persistent local server is required.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as request } from 'undici';
import { SavedStreams, accountScope } from '../proxy/savedStreams.mjs';
import { readPrivateSnapshot, uploadPrivateSnapshot } from '../proxy/syncStreams.mjs';
import { mergeCatalogue, resolvePublicStream, syncAddresses, validCatalogue } from '../proxy/incrementalSync.mjs';
import { readPrivateJson, writePrivateJson } from '../proxy/privateSnapshot.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = option('--directory') || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'TeslaIPTV');
const dispatcher = new Agent({ connect: { family: 4, timeout: 5000 }, allowH2: false });
let releaseLock;
try {
  const config = process.env.XTREAM_SERVER && process.env.XTREAM_USERNAME && process.env.XTREAM_PASSWORD
    ? { server: process.env.XTREAM_SERVER, username: process.env.XTREAM_USERNAME, password: process.env.XTREAM_PASSWORD }
    : JSON.parse(await fs.readFile(option('--config') || path.join(project, 'public', 'config.json'), 'utf8'));
  const scope = accountScope(config);
  if (!scope) throw new Error('Invalid account');
  const maxResolve = Number(option('--resolve-limit') ?? 20);
  if (!Number.isInteger(maxResolve) || maxResolve < 0 || maxResolve > 10000) throw new Error('Invalid discovery limit');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Competing invocations must not overwrite each other's progress. A crashed
  // process leaves a PID lock which a later run can recover after checking it.
  const lock = path.join(directory, `sync-${scope}.lock`);
  try {
    const pid = Number(await fs.readFile(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid sync lock');
    try { process.kill(pid, 0); throw new Error('A sync is already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; await fs.unlink(lock); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lockFile = await fs.open(lock, 'wx', 0o600);
  await lockFile.writeFile(String(process.pid));
  await lockFile.close();
  releaseLock = () => fs.unlink(lock);
  const repository = option('--repository');
  const addressPath = option('--path') || 'resolved-streams.json';
  const cataloguePath = path.posix.join(path.posix.dirname(addressPath), 'catalogue-snapshot.json');
  const remoteAddresses = repository ? await readPrivateSnapshot({ repository, filePath: addressPath }) : { snapshot: null };
  const remoteCatalogue = repository ? await readPrivateSnapshot({ repository, filePath: cataloguePath }) : { snapshot: null };
  if (remoteAddresses.snapshot && (remoteAddresses.snapshot.scope !== scope || remoteAddresses.snapshot.version !== 1 || !Array.isArray(remoteAddresses.snapshot.entries))) throw new Error('Invalid remote address account');
  const catalogueFile = path.join(directory, `catalogue-${scope}.json`);
  const localCatalogue = await readPrivateJson(catalogueFile);
  for (const candidate of [localCatalogue, remoteCatalogue.snapshot]) if (candidate && !validCatalogue(candidate, scope)) throw new Error('Invalid catalogue account');
  const previousCatalogue = [localCatalogue, remoteCatalogue.snapshot].filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  const fetchList = async action => {
    const endpoint = new URL('/player_api.php', config.server);
    for (const key of ['username', 'password']) endpoint.searchParams.set(key, config[key]);
    endpoint.searchParams.set('action', action);
    const response = await request(endpoint, { dispatcher, signal: AbortSignal.timeout(25000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Provider catalogue unavailable'); }
    return response.json();
  };
  const channels = option('--catalogue') ? await readPrivateJson(option('--catalogue')) : await fetchList('get_live_streams');
  const categories = option('--categories') ? await readPrivateJson(option('--categories')) : await fetchList('get_live_categories');
  const now = Date.now();
  const observedAt = option('--catalogue') ? Math.min(now, (await fs.stat(option('--catalogue'))).mtimeMs) : now;
  const delta = mergeCatalogue(previousCatalogue, channels, categories, config, now);
  const store = new SavedStreams({ directory, scope });
  if (remoteAddresses.snapshot) await store.merge(remoteAddresses.snapshot);
  const stateFile = path.join(directory, `sync-progress-${scope}.json`);
  const oldState = await readPrivateJson(stateFile);
  const state = oldState?.scope === scope ? oldState.attempts || {} : {};
  const deadline = now + 3 * 60 * 1000;
  const result = await syncAddresses({ store, channels, catalogue: delta.snapshot, previousCatalogue, creds: config, now, observedAt, maxResolve, deadlineAt: deadline, state,
    resolve: async channel => {
      return resolvePublicStream(channel, config, { request: (url, opts) => request(url, { ...opts, dispatcher }), timeoutMs: Math.min(8000, deadline - Date.now()) });
    },
    onProgress: async progress => {
      await store.flush();
      await writePrivateJson(stateFile, { scope, attempts: { ...state, ...progress.state } });
      console.log(`Discovery: checked=${progress.stats.attempted}, resolved=${progress.stats.resolved}`);
    },
  });
  const snapshot = await store.snapshot();
  await store.flush();
  const output = path.join(directory, 'resolved-streams.json');
  await writePrivateJson(output, snapshot);
  await writePrivateJson(catalogueFile, delta.snapshot);
  await writePrivateJson(stateFile, { scope, attempts: result.state });
  console.log(`Catalogue: total=${delta.snapshot.channels.length}, added=${delta.stats.added}, updated=${delta.stats.updated}, unchanged=${delta.stats.unchanged}, retained=${delta.stats.retained}`);
  console.log(`Addresses: total=${snapshot.entries.length}, changed=${result.stats.changed}, kept=${result.stats.kept}, discovered=${result.stats.resolved}, pending=${result.stats.remaining}`);
  console.log(`Snapshot: ${output}`);
  if (repository) {
    const addressCommit = await uploadPrivateSnapshot({ repository, snapshot, filePath: addressPath, expectedSha: remoteAddresses.sha });
    const catalogueCommit = await uploadPrivateSnapshot({ repository, snapshot: delta.snapshot, filePath: cataloguePath, expectedSha: remoteCatalogue.sha });
    console.log(`Private backup: addresses=${addressCommit ? 'updated' : 'unchanged'}, catalogue=${catalogueCommit ? 'updated' : 'unchanged'}. No local process needs to remain running.`);
  }
} catch (error) {
  console.error('Stream sync failed. Check the provider connection, local account configuration and private GitHub repository access.');
  const code = error.cause?.code || error.code || error.name;
  if (/^[A-Za-z0-9_]{1,64}$/.test(code || '')) console.error(`Failure type: ${code}`);
  process.exitCode = 1;
} finally { await dispatcher.destroy(); if (releaseLock) await releaseLock(); }

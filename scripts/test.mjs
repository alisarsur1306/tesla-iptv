// Run fixture tests without deployment credentials, live proxies, local source
// files or persistent production caches. Node 24 is used by CI and Render.
import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempParent = await realpath(os.tmpdir());
const runDirectory = await mkdtemp(path.join(tempParent, 'tesla-iptv-test-'));
const snapshot = path.join(runDirectory, 'project');
const dependencies = path.join(snapshot, 'node_modules');
let dependenciesLinked = false;

// This list follows hlsProxy.mjs, server.js and the Render/Tailscale startup
// scripts. Prefixes cover future account/transport options in the same family.
const deploymentVariable = /^(?:XTREAM_|M3U_|TS_|UPSTREAM_PROXY_|RENDER(?:_|$))|^(?:ACCESS_KEY|UPSTREAM_PROXY|PROXY_HOSTS|PROXY_TOKEN|CACHE_DIR|HOST|PORT)$/i;
const proxyVariable = /^(?:NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !deploymentVariable.test(key) && !proxyVariable.test(key)));
environment.NODE_ENV = 'test';
environment.CACHE_DIR = path.join(runDirectory, 'cache');
// Both our cache and tests calling os.tmpdir()/mkdtemp stay inside this run.
environment.TMPDIR = environment.TMP = environment.TEMP = path.join(runDirectory, 'tmp');

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(fullPath));
    else if (/\.test\.(?:mjs|js|ts)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

try {
  await mkdir(snapshot);
  await mkdir(environment.CACHE_DIR);
  await mkdir(environment.TMP);
  // Keeping imports under a temporary project also prevents a developer's
  // ignored public/config.json or playlist.m3u from being used as a fallback.
  // Tests read the installed dependencies through a link; they are not copied.
  await copyFile(path.join(project, 'package.json'), path.join(snapshot, 'package.json'));
  for (const directory of ['proxy', 'src']) {
    await cp(path.join(project, directory), path.join(snapshot, directory), { recursive: true });
  }
  await symlink(path.join(project, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  dependenciesLinked = true;
  const tests = [...await discover(path.join(snapshot, 'proxy')), ...await discover(path.join(snapshot, 'src'))].sort();
  if (!tests.length) throw new Error('No test files found');
  const child = spawn(process.execPath, ['--test', ...tests.map((file) => path.relative(snapshot, file))], {
    cwd: snapshot,
    env: environment,
    stdio: 'inherit',
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  // Remove the dependency link explicitly before recursive cleanup. Check the
  // resolved run directory is the task's own temp child on every platform.
  const actual = await realpath(runDirectory);
  const relative = path.relative(tempParent, actual);
  if (path.dirname(relative) !== '.' || !path.basename(relative).startsWith('tesla-iptv-test-')) {
    throw new Error('Refusing to clean a test directory outside the expected temporary location');
  }
  if (dependenciesLinked) await unlink(dependencies);
  await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

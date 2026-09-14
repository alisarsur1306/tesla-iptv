import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const helper = fileURLToPath(new URL('./startupDiagnostics.sh', import.meta.url)).replace(/\\/g, '/');
const fixturePrefix = path.join(os.tmpdir(), 'startup-probe-test-');
const fixtures = await mkdtemp(fixturePrefix);
const calls = path.join(fixtures, 'calls');
const shellFixtures = fixtures.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);

await writeFile(path.join(fixtures, 'timeout'), `#!/usr/bin/env bash
printf 'timeout:%s:%s\\n' "$1" "$2" >> "$STUB_CALLS"
[[ "$1" = '--signal=KILL' ]] || exit 90
shift 2
exec "$@"
`, { mode: 0o755 });
await writeFile(path.join(fixtures, 'tailscale'), `#!/usr/bin/env bash
printf 'tailscale' >> "$STUB_CALLS"
printf ':<%s>' "$@" >> "$STUB_CALLS"
printf '\\n' >> "$STUB_CALLS"
echo 'PRIVATE_TAILSCALE_STDOUT'
echo 'PRIVATE_TAILSCALE_STDERR' >&2
exit "$STUB_TSMP_EXIT"
`, { mode: 0o755 });
await writeFile(path.join(fixtures, 'curl'), `#!/usr/bin/env bash
printf 'curl' >> "$STUB_CALLS"
printf ':<%s>' "$@" >> "$STUB_CALLS"
printf '\\n' >> "$STUB_CALLS"
echo 'PRIVATE_CURL_STDERR' >&2
for target; do :; done
if [[ "$target" = 'http://1.1.1.1/' ]]; then
  printf '%s' "$STUB_NUMERIC_STATUS"
  exit "$STUB_NUMERIC_EXIT"
fi
printf '%s' "$STUB_HOSTNAME_STATUS"
exit "$STUB_HOSTNAME_EXIT"
`, { mode: 0o755 });

async function run(overrides = {}) {
  await writeFile(calls, '');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c',
    'export PATH="$STUB_BIN:/usr/bin:/bin"; [[ "$(command -v curl)" = "$STUB_BIN/curl" && "$(command -v timeout)" = "$STUB_BIN/timeout" ]] || exit 91; exec bash "$@"',
    'test-harness', helper, '/tmp/tailscaled.sock', '100.64.0.7', '127.0.0.1:1055'], {
    cwd: fixtures, encoding: 'utf8', timeout: 5000,
    env: {
      ...process.env,
      PATH: `${fixtures}${path.delimiter}${process.env.PATH || ''}`,
      STUB_CALLS: calls.replace(/\\/g, '/'),
      STUB_BIN: shellFixtures,
      STUB_TSMP_EXIT: '0', STUB_NUMERIC_STATUS: '301', STUB_NUMERIC_EXIT: '0',
      STUB_HOSTNAME_STATUS: '200', STUB_HOSTNAME_EXIT: '0',
      NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: 'http://must-not-be-used.invalid',
      ...overrides,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'probe failures never prevent app startup');
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|100\.64\.0\.7|must-not-be-used/);
  return { output: result.stdout, calls: await readFile(calls, 'utf8') };
}

test('startup probes use bounded TSMP and explicit proxy HTTP without curlrc or bypass', async () => {
  const result = await run();
  assert.match(result.output, /tsmp=reachable/);
  assert.match(result.output, /numeric_http=response http=301/);
  assert.match(result.output, /hostname_http=response http=200/);
  assert.match(result.calls, /timeout:--signal=KILL:5s/);
  assert.equal(result.calls.match(/timeout:--signal=KILL:10s/g)?.length, 2);
  assert.match(result.calls, /tailscale:<--socket=\/tmp\/tailscaled.sock>:<ping>:<--tsmp>:<--c=1>:<--timeout=5s>:<100.64.0.7>/);
  for (const curl of result.calls.split('\n').filter((line) => line.startsWith('curl:'))) {
    assert.match(curl, /^curl:<-q>/);
    assert.match(curl, /<--proxy>:<http:\/\/127\.0\.0\.1:1055>/);
    assert.match(curl, /<--noproxy>:<>/);
    assert.match(curl, /<--connect-timeout>:<5>:<--max-time>:<10>/);
    assert.match(curl, /<--retry>:<0>:<--no-location>/);
    assert.match(curl, /<--output>:<\/dev\/null>/);
    assert.doesNotMatch(curl, /--fail|--location>|--proxytunnel/);
  }
});

test('TSMP failure still permits the numeric probe, and numeric timeout skips hostname', async () => {
  const result = await run({ STUB_TSMP_EXIT: '1', STUB_NUMERIC_STATUS: '000', STUB_NUMERIC_EXIT: '28' });
  assert.match(result.output, /tsmp=unavailable exit=1/);
  assert.match(result.output, /numeric_http=no_response exit=28/);
  assert.match(result.output, /hostname_http=skipped/);
  assert.equal(result.calls.split('\n').filter((line) => line.startsWith('curl:')).length, 1);
});

test('HTTP errors count as responses and preserve the separate curl exit code', async () => {
  const result = await run({ STUB_NUMERIC_STATUS: '403', STUB_NUMERIC_EXIT: '28', STUB_HOSTNAME_STATUS: '502' });
  assert.match(result.output, /numeric_http=response http=403 exit=28/);
  assert.match(result.output, /hostname_http=response http=502/);
});

test('numeric response and hostname failure remain distinguishable', async () => {
  const result = await run({ STUB_HOSTNAME_STATUS: '000', STUB_HOSTNAME_EXIT: '6' });
  assert.match(result.output, /numeric_http=response/);
  assert.match(result.output, /hostname_http=no_response exit=6/);
});

test('unexpected curl stdout is suppressed instead of becoming log data', async () => {
  const result = await run({ STUB_NUMERIC_STATUS: 'PRIVATE_FAKE_TOKEN', STUB_NUMERIC_EXIT: '1' });
  assert.match(result.output, /numeric_http=no_response/);
});

test.after(async () => {
  assert.ok(path.resolve(fixtures).startsWith(path.resolve(fixturePrefix)));
  await rm(fixtures, { recursive: true, force: true });
});

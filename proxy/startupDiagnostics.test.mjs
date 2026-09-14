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
let runId = 0;
const shellFixtures = fixtures.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
const validStatus = {
  AuthURL: 'PRIVATE_AUTH_URL',
  Peer: { selected: { ExitNode: true, TailscaleIPs: ['100.64.0.7'], PeerAPIURL: ['http://100.64.0.7:32123'] } },
};

await writeFile(path.join(fixtures, 'node'), `#!/usr/bin/env bash
exec "$STUB_NODE" "$@"
`, { mode: 0o755 });

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
if [[ "$2" = 'status' ]]; then
  printf '%s' "$STUB_STATUS_JSON"
  echo 'PRIVATE_STATUS_STDERR' >&2
  exit "$STUB_STATUS_EXIT"
fi
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
if [[ "$target" = 'http://100.64.0.7:32123/dns-query?q=api.ipify.org&t=a' ]]; then
  printf '%s' "$STUB_PEER_STATUS"
  exit "$STUB_PEER_EXIT"
fi
if [[ "$target" = 'http://1.1.1.1/' ]]; then
  printf '%s' "$STUB_NUMERIC_STATUS"
  exit "$STUB_NUMERIC_EXIT"
fi
printf '%s' "$STUB_HOSTNAME_STATUS"
exit "$STUB_HOSTNAME_EXIT"
`, { mode: 0o755 });

async function run(overrides = {}, exitNode = '100.64.0.7') {
  const calls = path.join(fixtures, `calls-${++runId}`);
  await writeFile(calls, '');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c',
    'export PATH="$STUB_BIN:/usr/bin:/bin"; [[ "$(command -v curl)" = "$STUB_BIN/curl" && "$(command -v timeout)" = "$STUB_BIN/timeout" && "$(command -v node)" = "$STUB_BIN/node" ]] || exit 91; exec bash "$@"',
    'test-harness', helper, '/tmp/tailscaled.sock', exitNode, '127.0.0.1:1055'], {
    cwd: fixtures, encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env,
      PATH: `${fixtures}${path.delimiter}${process.env.PATH || ''}`,
      STUB_CALLS: calls.replace(/\\/g, '/'),
      STUB_BIN: shellFixtures,
      STUB_NODE: process.execPath.replace(/\\/g, '/'),
      STUB_TSMP_EXIT: '0', STUB_NUMERIC_STATUS: '301', STUB_NUMERIC_EXIT: '0',
      STUB_HOSTNAME_STATUS: '200', STUB_HOSTNAME_EXIT: '0',
      STUB_STATUS_JSON: JSON.stringify(validStatus), STUB_STATUS_EXIT: '0',
      STUB_PEER_STATUS: '200', STUB_PEER_EXIT: '0',
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
    assert.match(curl, /<--connect-timeout>:<5>:<--max-time>:<(?:8|10)>/);
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
  assert.equal(result.calls.split('\n').filter((line) => line.startsWith('curl:')).length, 2);
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

test('selected-exit DNS probe privately reads status and bounds same-proxy HTTP to eight seconds', async () => {
  const result = await run();
  assert.match(result.calls, /tailscale:<--socket=\/tmp\/tailscaled.sock>:<status>:<--json>/);
  assert.match(result.calls, /timeout:--signal=KILL:3s/);
  assert.match(result.calls, /timeout:--signal=KILL:8s/);
  assert.match(result.calls, /<--max-time>:<8>.*<--url>:<http:\/\/100\.64\.0\.7:32123\/dns-query\?q=api\.ipify\.org&t=a>/);
  assert.match(result.output, /peer_dns=response http=200 exit=0/);
  assert.doesNotMatch(result.output, /resolved|dns=ok|32123|api\.ipify/);
});

test('exit DNS forwarding HTTP500 and no response are distinguishable without blocking startup', async () => {
  const failed = await run({ STUB_PEER_STATUS: '500' });
  assert.match(failed.output, /peer_dns=response http=500 exit=0/);
  const timedOut = await run({ STUB_PEER_STATUS: '000', STUB_PEER_EXIT: '137' });
  assert.match(timedOut.output, /peer_dns=no_response exit=137/);
  const unexpected = await run({ STUB_PEER_STATUS: 'PRIVATE_DNS_BODY', STUB_PEER_EXIT: '1' });
  assert.match(unexpected.output, /peer_dns=no_response exit=1/);
});

test('invalid, unselected, mismatched, or noncanonical peer URLs never become probe targets', async () => {
  const invalidPeers = [
    { ExitNode: false, TailscaleIPs: ['100.64.0.7'], PeerAPIURL: ['http://100.64.0.7:32123'] },
    { ExitNode: true, TailscaleIPs: ['100.64.0.8'], PeerAPIURL: ['http://100.64.0.8:32123'] },
    ...[
      'http://127.0.0.1:32123', 'http://192.168.1.1:32123', 'http://100.64.0.8:32123',
      'http://PRIVATE_HOST:32123', 'http://PRIVATE_USER:PRIVATE_PASS@100.64.0.7:32123',
      'https://100.64.0.7:32123', 'http://100.64.0.7:32123/PRIVATE_PATH',
      'http://100.64.0.7:32123/?PRIVATE_QUERY', 'http://100.64.0.7:32123/#PRIVATE_HASH',
      'http://100.64.0.7:0', 'http://100.64.0.7:65536', 'http://100.64.0.7:32123/../',
      'http://100.64.0.7:32123/$(PRIVATE_SHELL)',
    ].map((url) => ({ ExitNode: true, TailscaleIPs: ['100.64.0.7'], PeerAPIURL: [url] })),
  ];
  for (const peer of invalidPeers) {
    const result = await run({ STUB_STATUS_JSON: JSON.stringify({ Peer: { selected: peer } }) });
    assert.match(result.output, /peer_dns=skipped reason=invalid_exit_status/);
    assert.doesNotMatch(result.calls, /<--url>:<[^\n]*dns-query/);
  }
  for (const status of ['PRIVATE_NOT_JSON', 'null', '{}', JSON.stringify({ Peer: { first: validStatus.Peer.selected, second: validStatus.Peer.selected } })]) {
    const result = await run({ STUB_STATUS_JSON: status });
    assert.match(result.output, /peer_dns=skipped reason=invalid_exit_status/);
    assert.doesNotMatch(result.calls, /<--url>:<[^\n]*dns-query/);
  }
});

test('status command failure cannot authorize a peer probe even with valid partial stdout', async () => {
  const result = await run({ STUB_STATUS_EXIT: '137' });
  assert.match(result.output, /peer_dns=skipped reason=invalid_exit_status/);
  assert.doesNotMatch(result.calls, /<--url>:<[^\n]*dns-query/);
});

test('configured exact exit DNSName or HostName still probes only the selected numeric peer', async () => {
  const status = { Peer: { selected: { ...validStatus.Peer.selected, DNSName: 'mac.example.ts.net.', HostName: 'home-mac' } } };
  for (const name of ['mac.example.ts.net', 'home-mac']) {
    const result = await run({ STUB_STATUS_JSON: JSON.stringify(status) }, name);
    assert.match(result.output, /peer_dns=response http=200/);
    assert.match(result.calls, /<--url>:<http:\/\/100\.64\.0\.7:32123\/dns-query\?q=api\.ipify\.org&t=a>/);
  }
  const mismatch = await run({ STUB_STATUS_JSON: JSON.stringify(status) }, 'unselected-mac');
  assert.match(mismatch.output, /peer_dns=skipped reason=invalid_exit_status/);
  assert.doesNotMatch(mismatch.calls, /<--url>:<[^\n]*dns-query/);
});

test.after(async () => {
  assert.ok(path.resolve(fixtures).startsWith(path.resolve(fixturePrefix)));
  await rm(fixtures, { recursive: true, force: true });
});

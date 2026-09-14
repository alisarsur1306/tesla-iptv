// Test helper: give this process its own channel-list cache directory.
//
// The server persists every list it loads to CACHE_DIR so a restarted container still has
// channels (see hlsProxy.mjs), and that directory defaults to one fixed path under the system
// temp dir. The whole suite therefore shared it: a list written by one test file was restored
// by the next, so a test that asked a cold server for fresh data was answered with another
// file's fixtures. The refusal record (unavailable.json) lives there too.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function useIsolatedCacheDir() {
  process.env.CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), 'tesla-iptv-test-'));
  return process.env.CACHE_DIR;
}

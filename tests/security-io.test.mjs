import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeJsonFile } from '../dist/io.js';
import { har } from './helpers.mjs';

const bin = resolve('dist/cli.js');
test('offline commands cannot reach network or process creation sinks with hostile evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-doctor-offline-security-'));
  try {
    const guard = join(dir, 'deny-network.cjs');
    await writeFile(
      guard,
      `let attempts = 0;
const deny = () => { attempts++; throw new Error('NETWORK_OR_PROCESS_SINK_REACHED'); };
process.on('exit', () => { if (attempts) process.stderr.write('NETWORK_OR_PROCESS_SINK_REACHED'); });
for (const [name, keys] of Object.entries({
  net: ['connect', 'createConnection', 'createServer'],
  tls: ['connect', 'createServer'],
  http: ['request', 'get', 'createServer'],
  https: ['request', 'get', 'createServer'],
  dns: ['lookup', 'resolve', 'resolve4', 'resolve6'],
  child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
})) for (const key of keys) require('node:' + name)[key] = deny;
require('node:net').Socket.prototype.connect = deny;
require('node:net').Server.prototype.listen = deny;
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) require('node:dns').promises[key] = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();
`,
    );
    const run = (args) =>
      spawnSync(process.execPath, ['--require', guard, bin, ...args], {
        encoding: 'utf8',
        timeout: 10000,
      });
    // Verify the instrumentation actually catches an attempted network operation.
    const control = spawnSync(
      process.execPath,
      ['--require', guard, '-e', "fetch('http://127.0.0.1:1')"],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.notEqual(control.status, 0);
    assert.match(control.stderr, /NETWORK_OR_PROCESS_SINK_REACHED/);
    const input = join(dir, 'input.json');
    const output = join(dir, 'report.json');
    const capture = har();
    capture.log.entries.push({
      request: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' },
      response: { status: 302, headers: [{ name: 'location', value: 'file:///etc/passwd' }] },
    });
    capture.ignored = '<script>fetch("https://attacker.invalid")</script>$(id)';
    await writeFile(input, JSON.stringify(capture));
    for (const [args, expected] of [
      [['inspect', input, '--json', '--out', output], 0],
      [['share', output], 0],
      [['compare', output, output], 3],
    ]) {
      const result = run(args);
      assert.equal(result.status, expected, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /NETWORK_OR_PROCESS_SINK_REACHED|CANARY/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deep unused JSON and terminal control payloads do not execute or reach CLI output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-doctor-depth-security-'));
  try {
    const path = join(dir, 'input.json');
    const nested = '['.repeat(20000) + '0' + ']'.repeat(20000);
    const base = JSON.stringify(har());
    await writeFile(
      path,
      base.slice(0, -1) + ',"ignored":' + nested + ',"attack":"\\u001b]52;c;CANARY\\u0007"}',
    );
    const result = spawnSync(process.execPath, [bin, 'inspect', path], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY|\x1b|\x07/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent private output creation has one winner and never clobbers it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-doctor-race-security-'));
  try {
    const path = join(dir, 'output.json');
    const outcomes = await Promise.allSettled(
      Array.from({ length: 32 }, (_, writer) => writeJsonFile(path, { writer })),
    );
    const winners = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [index] : [],
    );
    assert.equal(winners.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { writer: winners[0] });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

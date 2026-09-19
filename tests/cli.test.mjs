import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { har, entry, headers } from './helpers.mjs';
const bin = resolve('dist/cli.js');
const run = (args) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 15000 });
test('help, version and unknown options expose no secret arguments', () => {
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--version']).stdout, /^0\.1\.0\n$/);
  for (const args of [
    ['--CANARY_SECRET'],
    ['inspect'],
    ['share', 'report.json', '--strict'],
    ['inspect', 'file.har', '--insecure-no-sandbox'],
    ['capture', 'file:///CANARY_SECRET'],
    ['capture', 'https://app.example', '--duration', '0'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr + result.stdout, /CANARY_SECRET/);
  }
});
test('CLI inspect, JSON, exit codes, sharing and exclusive output behavior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-doctor-cli-'));
  try {
    const input = join(dir, 'input.har');
    const output = join(dir, 'output.json');
    await writeFile(input, JSON.stringify(har()));
    const result = run(['inspect', input, '--json', '--out', output]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.coverage.uploadsObserved, 1);
    assert.doesNotMatch(result.stdout, /CANARY/);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(run(['inspect', input, '--strict']).status, 3);
    const collision = run(['inspect', input, '--out', output]);
    assert.equal(collision.status, 2);
    assert.match(collision.stderr, /new filename/);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
    const shared = run(['share', output]);
    assert.equal(shared.status, 0, shared.stderr);
    assert.equal(JSON.parse(shared.stdout).visibility, 'share');
    assert.doesNotMatch(shared.stdout, /app\.example|cloudflarestorage/);
    assert.equal(run(['inspect', input, '--request', 'upload-999']).status, 2);
    const noUploads = join(dir, 'empty.har');
    await writeFile(noUploads, JSON.stringify({ log: { entries: [] } }));
    assert.equal(run(['inspect', noUploads]).status, 3);
    const failed = join(dir, 'failed.har');
    await writeFile(
      failed,
      JSON.stringify(
        har(
          entry({
            response: {
              status: 403,
              headers: headers({}),
              content: { text: '<Error><Code>AccessDenied</Code></Error>' },
            },
          }),
        ),
      ),
    );
    assert.equal(run(['inspect', failed]).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('malformed input, invalid UTF8, oversized input and symlinks fail without raw data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-doctor-input-'));
  try {
    const input = join(dir, 'CANARY_PATH_SECRET');
    await writeFile(input, '{"secret":"CANARY_PAYLOAD_SECRET"');
    const invalid = run(['inspect', input]);
    assert.equal(invalid.status, 2);
    assert.doesNotMatch(invalid.stderr, /CANARY/);
    await writeFile(input, Buffer.from([0xff, 0xfe, 0x7b]));
    assert.equal(run(['inspect', input]).status, 2);
    await writeFile(input, Buffer.alloc(32 * 1024 * 1024 + 1, 32));
    assert.equal(run(['inspect', input]).status, 2);
    assert.equal(run(['inspect', dir]).status, 2);
    if (process.platform !== 'win32') {
      await writeFile(input, JSON.stringify(har()));
      const link = join(dir, 'link.har');
      await symlink(input, link);
      assert.equal(run(['inspect', link]).status, 2);
      const linkedBin = join(dir, 'doctor.js');
      await symlink(bin, linkedBin);
      assert.equal(
        execFileSync(process.execPath, [linkedBin, '--version'], { encoding: 'utf8' }).trim(),
        '0.1.0',
      );
      const result = run(['inspect', input, '--out', link]);
      assert.equal(result.status, 2);
      assert.equal((await stat(input)).size, Buffer.byteLength(JSON.stringify(har())));
      const fifo = join(dir, 'pipe.har');
      execFileSync('mkfifo', [fifo]);
      const pipe = run(['inspect', fifo]);
      assert.equal(pipe.status, 2);
      assert.equal(pipe.signal, null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('offline library import works without loading optional browser module', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {inspectHar} from './dist/index.js'; console.log(inspectHar({log:{entries:[]}}).source)",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'har');
});

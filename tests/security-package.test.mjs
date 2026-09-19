import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { npmCommand } from '../scripts/npm-command.mjs';

const project = resolve('.');
const { command: npm, prefixArgs: npmArgs } = npmCommand();
const manifest = JSON.parse(await readFile(join(project, 'scripts/package-files.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (cwd, args = [], env = process.env) =>
  spawnSync(process.execPath, ['scripts/check-package.mjs', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

async function copyProject(destination) {
  for (const path of [
    ...manifest.files,
    'scripts/check-package.mjs',
    'scripts/npm-command.mjs',
    'scripts/package-files.json',
  ]) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await copyFile(join(project, path), join(destination, path));
  }
}

async function pack(cwd, destination) {
  const result = JSON.parse(
    execFileSync(
      npm,
      [...npmArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
      {
        cwd,
        encoding: 'utf8',
      },
    ),
  );
  return join(destination, result[0].filename);
}

function tarEntry(tar, wanted) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .split('\0')[0];
    if (!name) break;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    if (name === wanted) return { offset, size };
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Test archive entry missing');
}

test('package manifest rejects previously unreviewed files in every broad publish directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-package-injection-'));
  try {
    await copyProject(temp);
    assert.equal(manifest.files.length, 35);
    for (const path of [
      'dist/support-notes.json',
      'docs/operator-notes.txt',
      'examples/private-config.mjs',
    ]) {
      await writeFile(join(temp, path), 'PACKAGE_PRIVATE_CANARY');
      const result = run(temp);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unreviewed file/);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /PACKAGE_PRIVATE_CANARY|isolated offline import passed/,
      );
      await rm(join(temp, path));
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('tampered executable archive fails byte validation before package code runs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-package-tamper-'));
  try {
    const archive = await pack(project, temp);
    const tar = gunzipSync(await readFile(archive));
    const entry = tarEntry(tar, 'package/dist/cli.js');
    const payload = Buffer.from("process.stdout.write('PACKAGE_ATTACK_EXECUTED');\n");
    tar.fill(32, entry.offset + 512, entry.offset + 512 + entry.size);
    payload.copy(tar, entry.offset + 512);
    const modified = gzipSync(tar);
    const path = join(temp, 'tampered.tgz');
    await writeFile(path, modified);
    const result = run(project, ['--archive', path, '--sha256', digest(modified)]);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Archive bytes differ from reviewed checkout/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /PACKAGE_ATTACK_EXECUTED|isolated offline import passed/,
    );
    const mismatch = run(project, ['--archive', archive, '--sha256', '0'.repeat(64)]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Archive digest mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('archive links and duplicate members reject before isolated install', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-package-structure-'));
  try {
    const original = gunzipSync(await readFile(await pack(project, temp)));
    for (const kind of ['symlink', 'duplicate']) {
      const tar = Buffer.from(original);
      const entry = tarEntry(tar, 'package/dist/cli.js');
      if (kind === 'symlink') {
        tar[entry.offset + 156] = 50;
        Buffer.from('../../outside').copy(tar, entry.offset + 157);
      } else {
        tar.fill(0, entry.offset, entry.offset + 100);
        Buffer.from('package/LICENSE').copy(tar, entry.offset);
      }
      tar.fill(32, entry.offset + 148, entry.offset + 156);
      const sum = tar.subarray(entry.offset, entry.offset + 512).reduce((a, b) => a + b, 0);
      Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(tar, entry.offset + 148);
      const bytes = gzipSync(tar);
      const path = join(temp, `${kind}.tgz`);
      await writeFile(path, bytes);
      const result = run(project, ['--archive', path, '--sha256', digest(bytes)]);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        kind === 'symlink' ? /Only regular packaged files/ : /Duplicate archive member/,
      );
      assert.doesNotMatch(result.stdout, /isolated offline import passed/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('retained release artifact is the exact verified archive and output cannot overwrite', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-package-retained-'));
  try {
    const output = join(temp, 'release');
    const result = run(project, ['--out-dir', output]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(await readFile(join(output, 'metadata.json'), 'utf8'));
    assert.deepEqual((await readdir(output)).sort(), [metadata.filename, 'metadata.json'].sort());
    assert.deepEqual(metadata.files, manifest.files);
    const archive = join(output, metadata.filename);
    const before = await readFile(archive);
    assert.equal(digest(before), metadata.sha256);
    if (process.platform !== 'win32') {
      assert.equal((await stat(output)).mode & 0o777, 0o700);
      assert.equal((await stat(archive)).mode & 0o777, 0o600);
    }
    const replay = run(project, ['--archive', archive, '--sha256', metadata.sha256]);
    assert.equal(replay.status, 0, replay.stderr);
    const overwrite = run(project, ['--out-dir', output]);
    assert.notEqual(overwrite.status, 0);
    assert.deepEqual(await readFile(archive), before);
    assert.equal(
      (await readdir(project)).some((name) => name.endsWith('.tgz')),
      false,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('package checks preserve spaces and ampersands in project and temporary paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-package-paths-'));
  try {
    const fixture = join(temp, 'project with spaces & literal segment');
    const scratch = join(temp, 'temporary with spaces & literal segment');
    const packed = join(temp, 'packed with spaces & literal segment');
    await mkdir(scratch);
    await mkdir(packed);
    await copyProject(fixture);
    const archive = await pack(fixture, packed);
    const archiveDigest = digest(await readFile(archive));
    const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    const checked = run(fixture, ['--archive', archive, '--sha256', archiveDigest], env);
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr);
    // Direct `node scripts/check-package.mjs` does not inherit npm_execpath in
    // the release workflow. Cover the standard Windows Node installation too.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'npm_execpath') delete env[key];
    }
    const retained = join(temp, 'retained with spaces & literal segment');
    const direct = run(fixture, ['--out-dir', retained], env);
    assert.ifError(direct.error);
    assert.equal(direct.status, 0, direct.stderr);
    const metadata = JSON.parse(await readFile(join(retained, 'metadata.json'), 'utf8'));
    assert.equal(digest(await readFile(join(retained, metadata.filename))), metadata.sha256);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

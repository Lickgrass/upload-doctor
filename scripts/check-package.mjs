import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, open, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { npmCommand } from './npm-command.mjs';

const MAX_ARCHIVE = 1024 * 1024;
const MAX_UNPACKED = 2 * 1024 * 1024;
const { command: npm, prefixArgs: npmArgs } = npmCommand();
const cwd = process.cwd();
const { values, positionals } = parseArgs({
  strict: true,
  options: {
    'out-dir': { type: 'string' },
    archive: { type: 'string' },
    sha256: { type: 'string' },
  },
});
assert.equal(positionals.length, 0, 'Unexpected package-check arguments');
assert.ok(!values['out-dir'] || !values.archive, 'Use either --out-dir or --archive');
assert.equal(Boolean(values.archive), Boolean(values.sha256), '--archive requires --sha256');
if (values.sha256) assert.match(values.sha256, /^[a-f0-9]{64}$/, 'Invalid archive digest');
if (values['out-dir'] !== undefined) assert.ok(values['out-dir'], 'Output directory is empty');

const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@lickgrass/upload-doctor');
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const filename = `lickgrass-upload-doctor-${pkg.version}.tgz`;
const manifest = JSON.parse(await readFile(join(cwd, 'scripts/package-files.json'), 'utf8'));
assert.equal(manifest.version, 1);
assert.ok(
  Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length < 128,
);
assert.ok(
  manifest.files.every(
    (path) =>
      typeof path === 'string' &&
      /^[a-zA-Z0-9._/-]+$/.test(path) &&
      !path.startsWith('/') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
  ),
  'Invalid reviewed package manifest',
);
assert.equal(new Set(manifest.files).size, manifest.files.length);
const expected = [...manifest.files].sort();

async function readRegularArchive(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= MAX_ARCHIVE, 'Invalid or oversized package archive');
    const bytes = Buffer.alloc(MAX_ARCHIVE + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    assert.ok(size <= MAX_ARCHIVE, 'Package archive exceeds size limit');
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

// npm emits ordinary ustar regular files for this reviewed path set. Reject other
// archive forms (links, extensions, duplicates, traversal) before npm sees them.
function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED + 128 * 1024 });
  assert.equal(tar.length % 512, 0, 'Invalid archive block length');
  const files = new Map();
  let total = 0;
  const string = (buffer) => {
    const end = buffer.indexOf(0);
    const used = end < 0 ? buffer : buffer.subarray(0, end);
    assert.ok(
      used.every((byte) => byte >= 32 && byte < 127),
      'Non-ASCII archive field',
    );
    if (end >= 0) assert.ok(buffer.subarray(end).every((byte) => byte === 0));
    return used.toString('ascii');
  };
  const octal = (buffer) => {
    const value = buffer
      .toString('ascii')
      .replace(/[\0 ]+$/g, '')
      .trimStart();
    assert.match(value, /^[0-7]+$/, 'Invalid archive number');
    return Number.parseInt(value, 8);
  };
  let ended = false;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        tar.subarray(offset).every((byte) => byte === 0),
        'Trailing archive data',
      );
      ended = true;
      break;
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert.equal(octal(header.subarray(148, 156)), checksum, 'Invalid archive checksum');
    assert.ok(header[156] === 0 || header[156] === 48, 'Only regular packaged files are allowed');
    assert.equal(string(header.subarray(157, 257)), '', 'Archive links are prohibited');
    const prefix = string(header.subarray(345, 500));
    const name = string(header.subarray(0, 100));
    const path = prefix ? `${prefix}/${name}` : name;
    assert.ok(path.startsWith('package/'), 'Invalid archive root');
    const relative = path.slice('package/'.length);
    assert.ok(expected.includes(relative), 'Archive contains an unreviewed file');
    assert.ok(!files.has(relative), 'Duplicate archive member');
    const size = octal(header.subarray(124, 136));
    total += size;
    assert.ok(total <= MAX_UNPACKED, 'Package unexpectedly large');
    assert.ok(offset + 512 + size <= tar.length, 'Truncated archive member');
    files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(ended, 'Missing archive terminator');
  assert.deepEqual(
    [...files.keys()].sort(),
    expected,
    'Package differs from reviewed file manifest',
  );
  return { files, total };
}

const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-pack-'));
let createdOutput;
try {
  const archive = join(temp, filename);
  let bytes;
  if (values.archive) {
    bytes = await readRegularArchive(resolve(values.archive));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      values.sha256,
      'Archive digest mismatch',
    );
  } else {
    const packed = JSON.parse(
      execFileSync(
        npm,
        [...npmArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp],
        {
          cwd,
          encoding: 'utf8',
        },
      ),
    );
    assert.equal(packed.length, 1);
    assert.equal(packed[0].filename, filename);
    bytes = await readRegularArchive(archive);
    await rm(archive);
  }
  const { files, total } = archiveFiles(bytes);
  for (const [path, content] of files) {
    const source = join(cwd, path);
    assert.ok((await lstat(source)).isFile(), 'Reviewed package source must be a regular file');
    assert.ok(
      content.equals(await readFile(source)),
      'Archive bytes differ from reviewed checkout',
    );
  }
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }), {
    flag: 'wx',
    mode: 0o600,
  });
  execFileSync(
    npm,
    [
      ...npmArgs,
      'install',
      '--ignore-scripts',
      '--offline',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      archive,
    ],
    { cwd: temp, encoding: 'utf8' },
  );
  const installed = join(temp, 'node_modules', '@lickgrass', 'upload-doctor');
  for (const [path, content] of files) {
    assert.ok(
      content.equals(await readFile(join(installed, path))),
      'Installed package bytes differ',
    );
  }
  const version = execFileSync(process.execPath, [join(installed, 'dist/cli.js'), '--version'], {
    cwd: temp,
    encoding: 'utf8',
  }).trim();
  assert.equal(version, pkg.version);
  const testFile = join(temp, 'consumer.mjs');
  await writeFile(
    testFile,
    "import {inspectHar,reportExitCode} from '@lickgrass/upload-doctor'; const r=inspectHar({log:{entries:[]}}); if(reportExitCode(r)!==3)throw Error('Invalid installed API'); console.log('isolated offline import passed');",
    { flag: 'wx', mode: 0o600 },
  );
  const result = execFileSync(process.execPath, [testFile], { cwd: temp, encoding: 'utf8' }).trim();
  assert.equal(
    createHash('sha256')
      .update(await readRegularArchive(archive))
      .digest('hex'),
    sha256,
  );
  const metadata = {
    schemaVersion: 1,
    filename,
    name: pkg.name,
    version: pkg.version,
    sha256,
    archiveBytes: bytes.length,
    unpackedBytes: total,
    files: expected,
  };
  if (values['out-dir']) {
    const output = resolve(values['out-dir']);
    await mkdir(output, { mode: 0o700 });
    createdOutput = output;
    await writeFile(join(output, filename), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    createdOutput = undefined;
  }
  console.log(
    `Package verified: ${files.size} reviewed files, ${total} unpacked bytes; ${result}. SHA256 ${sha256}`,
  );
} finally {
  if (createdOutput) await rm(createdOutput, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
}

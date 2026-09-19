import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cwd = process.cwd();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'upload-doctor-pack-'));
try {
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
      cwd,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  );
  assert.equal(packed.length, 1);
  const fileNames = packed[0].files.map((f) => f.path);
  for (const required of [
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/browser.js',
    'dist/browser.d.ts',
    'README.md',
    'LICENSE',
    'SECURITY.md',
    'schemas/contract.schema.json',
    'schemas/report.schema.json',
  ])
    assert.ok(fileNames.includes(required), `Missing packaged file: ${required}`);
  assert.ok(
    !fileNames.some((p) => /node_modules|^tests\/|\.har$|\.env|local\.json|^src\//.test(p)),
    'Private or development input leaked into package',
  );
  assert.ok(packed[0].unpackedSize < 2 * 1024 * 1024, 'Package unexpectedly large');
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const archive = resolve(temp, packed[0].filename);
  execFileSync(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--offline',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      archive,
    ],
    { cwd: temp, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const installed = join(temp, 'node_modules', '@lickgrass', 'upload-doctor');
  const version = execFileSync(process.execPath, [join(installed, 'dist/cli.js'), '--version'], {
    cwd: temp,
    encoding: 'utf8',
  }).trim();
  assert.equal(version, pkg.version);
  const testFile = join(temp, 'consumer.mjs');
  await writeFile(
    testFile,
    "import {inspectHar,reportExitCode} from '@lickgrass/upload-doctor'; const r=inspectHar({log:{entries:[]}}); if(reportExitCode(r)!==3)throw Error('Invalid installed API'); console.log('isolated offline import passed');",
  );
  const result = execFileSync(process.execPath, [testFile], { cwd: temp, encoding: 'utf8' }).trim();
  console.log(
    `Package verified: ${fileNames.length} files, ${packed[0].unpackedSize} unpacked bytes; ${result}.`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

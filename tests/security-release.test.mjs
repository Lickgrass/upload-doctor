import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

// Exercise the actual workflow guards without an Actions runner, token, or publication.
function guard(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing release guard: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const step = workflow.slice(start, end === -1 ? undefined : end);
  const match =
    /          node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE(?:\n|$)/.exec(step);
  assert.ok(match, `Missing executable guard: ${name}`);
  return match[1].replace(/^          /gm, '');
}

test('release guards reject mismatched tags, commits, and injected ref input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-doctor-release-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GITHUB_') && !key.startsWith('GIT_'),
    ),
  );
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '--quiet');
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@lickgrass/upload-doctor', version: '0.1.0' }),
    );
    git('add', 'package.json');
    git(
      '-c',
      'user.name=Upload Doctor synthetic test',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Synthetic release identity fixture',
    );
    const commit = git('rev-parse', 'HEAD');
    const archiveDirectory = join(directory, 'upload-doctor-release');
    const archiveBytes = Buffer.from('Synthetic retained archive');
    mkdirSync(archiveDirectory);
    writeFileSync(join(archiveDirectory, 'lickgrass-upload-doctor-0.1.0.tgz'), archiveBytes);
    const metadata = {
      schemaVersion: 1,
      name: '@lickgrass/upload-doctor',
      version: '0.1.0',
      filename: 'lickgrass-upload-doctor-0.1.0.tgz',
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
      archiveBytes: archiveBytes.length,
    };
    const metadataPath = join(archiveDirectory, 'metadata.json');
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const valid = {
      RELEASE_TAG: 'v0.1.0',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF: 'refs/tags/v0.1.0',
      GITHUB_SHA: commit,
      CANDIDATE_COMMIT: commit,
      GITHUB_RUN_ID: '123',
      CANDIDATE_RUN_ID: '123',
      ARTIFACT_ID: '456',
      ARCHIVE_NAME: 'lickgrass-upload-doctor-0.1.0.tgz',
      ARCHIVE_SHA256: 'c'.repeat(64),
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: join(directory, 'output'),
    };
    const execute = (name, overrides = {}) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', guard(name)], {
        cwd: directory,
        env: { ...env, ...valid, ...overrides },
        encoding: 'utf8',
        timeout: 5000,
      });
    for (const name of [
      'Validate tag input',
      'Check reviewed commit and package version',
      'Record tested archive identity',
      'Check publication source identity',
    ]) {
      const result = execute(name);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    assert.equal(
      readFileSync(valid.GITHUB_OUTPUT, 'utf8'),
      `filename=lickgrass-upload-doctor-0.1.0.tgz\nsha256=${createHash('sha256').update(archiveBytes).digest('hex')}\nrun-id=123\n`,
    );
    for (const overrides of [
      { GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/main' },
      { GITHUB_REF: 'refs/tags/v9.9.9' },
      { GITHUB_REF: 'refs/tags/v0.1.0$(touch SHOULD_NOT_EXIST)' },
      { GITHUB_REF: '' },
      { RELEASE_TAG: '' },
      { RELEASE_TAG: 'v0.1.0\n' },
      { RELEASE_TAG: 'v0.1.0; node -e "process.exit(0)"' },
      { RELEASE_TAG: '$(touch SHOULD_NOT_EXIST)' },
      { RELEASE_TAG: 'v0.1.0/../../main' },
      { GITHUB_SHA: '' },
      { GITHUB_SHA: 'not-a-commit' },
    ]) {
      for (const name of ['Validate tag input', 'Check publication source identity']) {
        const result = execute(name, overrides);
        assert.equal(result.status, 1, `${name} accepted ${JSON.stringify(overrides)}`);
      }
    }
    for (const name of [
      'Check reviewed commit and package version',
      'Record tested archive identity',
      'Check publication source identity',
    ]) {
      assert.equal(execute(name, { GITHUB_SHA: 'a'.repeat(40) }).status, 1);
    }
    assert.equal(
      execute('Check publication source identity', { CANDIDATE_COMMIT: 'b'.repeat(40) }).status,
      1,
    );
    assert.equal(
      execute('Check reviewed commit and package version', { RELEASE_TAG: 'v0.2.0' }).status,
      1,
    );
    for (const overrides of [
      { CANDIDATE_RUN_ID: '999' },
      { GITHUB_RUN_ID: '' },
      { ARTIFACT_ID: '' },
      { ARTIFACT_ID: '1,2' },
      { ARTIFACT_ID: '0' },
      { ARTIFACT_ID: '9007199254740992' },
      { ARCHIVE_NAME: '../lickgrass-upload-doctor-0.1.0.tgz' },
      { ARCHIVE_NAME: 'lickgrass-upload-doctor-0.2.0.tgz' },
      { ARCHIVE_SHA256: 'not-a-hash' },
    ]) {
      assert.equal(execute('Check publication source identity', overrides).status, 1);
    }
    for (const overrides of [
      { schemaVersion: 2 },
      { name: '@attacker/other-package' },
      { version: '0.2.0' },
      { filename: '../other.tgz' },
      { sha256: 'a'.repeat(64) },
      { archiveBytes: metadata.archiveBytes + 1 },
    ]) {
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, ...overrides }));
      assert.equal(execute('Record tested archive identity').status, 1);
    }
    assert.throws(() => readFileSync(join(directory, 'SHOULD_NOT_EXIST')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publication guard verifies the exact archive bytes without executing package contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-doctor-release-archive-'));
  const artifactDirectory = join(directory, 'upload-doctor-publish');
  const filename = 'lickgrass-upload-doctor-0.1.0.tgz';
  const archive = join(artifactDirectory, filename);
  const output = join(directory, 'output');
  // The byte guard does not parse or execute the package. Package validation runs
  // on the same archive beforehand in the separate job without an OIDC grant.
  const bytes = Buffer.from('Synthetic exact-byte validation fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const env = {
    ...process.env,
    RUNNER_TEMP: directory,
    RELEASE_TAG: 'v0.1.0',
    ARCHIVE_NAME: filename,
    ARCHIVE_SHA256: hash,
    GITHUB_OUTPUT: output,
  };
  const execute = (overrides = {}) => {
    rmSync(output, { force: true });
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-e', guard('Verify exact tested bytes')],
      {
        cwd: directory,
        env: { ...env, ...overrides },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  };
  try {
    mkdirSync(artifactDirectory);
    writeFileSync(archive, bytes);
    assert.equal(execute().status, 0);
    assert.equal(readFileSync(output, 'utf8'), `archive=${archive}\n`);
    for (const overrides of [
      { ARCHIVE_SHA256: 'a'.repeat(64) },
      { ARCHIVE_NAME: `../${filename}` },
      { RELEASE_TAG: 'v0.2.0' },
      { RELEASE_TAG: 'v0.1.0;touch SHOULD_NOT_EXIST' },
    ]) {
      assert.equal(execute(overrides).status, 1);
      assert.throws(() => readFileSync(output));
    }
    writeFileSync(archive, 'corrupt bytes');
    assert.equal(execute().status, 1);
    writeFileSync(archive, bytes);
    writeFileSync(join(artifactDirectory, '.npmrc'), 'registry=https://attacker.invalid');
    assert.equal(execute().status, 1);
    rmSync(join(artifactDirectory, '.npmrc'));
    writeFileSync(archive, Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.equal(execute().status, 1);
    writeFileSync(archive, Buffer.alloc(0));
    assert.equal(execute().status, 1);
    rmSync(archive);
    mkdirSync(archive);
    assert.equal(execute().status, 1);
    rmSync(archive, { recursive: true });
    if (process.platform !== 'win32') {
      const target = join(directory, 'target');
      writeFileSync(target, bytes);
      symlinkSync(target, archive);
      assert.equal(execute().status, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OIDC publication job does not check out or execute project code', () => {
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  assert.doesNotMatch(
    publish,
    /actions\/checkout|npm (?:ci|install|run|pack)|npx|check-package|ci-chromium-sandbox|node scripts\//,
  );
  assert.match(publish, /artifact-ids: \$\{\{ needs\.validate\.outputs\.artifact-id \}\}/);
  assert.match(publish, /digest-mismatch: error/);
  assert.doesNotMatch(publish, /github-token:|repository:|run-id:/);
  assert.match(
    publish,
    /run: npm publish "\$ARCHIVE_PATH" --access public --provenance --ignore-scripts --registry https:\/\/registry\.npmjs\.org\/\n/,
  );
  const imports = [...publish.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  assert.ok(imports.every((name) => name.startsWith('node:')));
  assert.match(
    workflow,
    /node scripts\/check-package\.mjs --out-dir "\$RUNNER_TEMP\/upload-doctor-release"/,
  );
  assert.match(workflow, /overwrite: false/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  publish:\n')), /id-token: write/);
});

test('hosted sandbox setup has unconditional cleanup only in browser validation jobs', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  function job(text, name) {
    const start = text.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1);
    const body = text.slice(start + 1);
    const next = body.slice(1).search(/\n  [a-zA-Z0-9_]+:\n/);
    return next < 0 ? body : body.slice(0, next + 1);
  }
  for (const [body, command] of [
    [job(ci, 'browser'), 'npm run test:browser'],
    [job(workflow, 'validate'), 'npm run check'],
  ]) {
    const installation = body.indexOf('playwright install --with-deps chromium');
    const setup = body.indexOf('node scripts/ci-chromium-sandbox.mjs setup');
    const tests = body.indexOf(`run: ${command}\n`);
    const cleanup = body.indexOf('node scripts/ci-chromium-sandbox.mjs cleanup');
    assert.ok(installation >= 0 && installation < setup && setup < tests && tests < cleanup);
    const cleanupStep = body.slice(body.lastIndexOf('      - name:', cleanup), cleanup);
    assert.match(cleanupStep, /\n        if: always\(\)\n/);
    assert.doesNotMatch(body, /id-token: write|--no-sandbox|sysctl/);
  }
  assert.doesNotMatch(job(workflow, 'publish'), /ci-chromium-sandbox|apparmor|sudo/);
  for (const name of ['offline', 'audit', 'artifact_build', 'artifact_verify']) {
    assert.doesNotMatch(job(ci, name), /ci-chromium-sandbox|apparmor|sudo/);
  }
});

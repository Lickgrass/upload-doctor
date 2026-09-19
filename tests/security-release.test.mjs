import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const valid = {
      RELEASE_TAG: 'v0.1.0',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF: 'refs/tags/v0.1.0',
      GITHUB_SHA: commit,
      CANDIDATE_COMMIT: commit,
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
      'Check publication source identity',
    ]) {
      const result = execute(name);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
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
    assert.throws(() => readFileSync(join(directory, 'SHOULD_NOT_EXIST')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

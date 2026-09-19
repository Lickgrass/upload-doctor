import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProfile } from '../scripts/ci-chromium-sandbox.mjs';

const cache = '/home/runner/.cache/ms-playwright';
const binaries = [
  `${cache}/chromium-1243/chrome-linux64/chrome`,
  `${cache}/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
];

test('CI AppArmor profile grants namespaces only to the two exact installed binary paths', () => {
  const profile = buildProfile(cache, binaries);
  assert.equal((profile.match(/userns,/g) ?? []).length, 2);
  assert.equal((profile.match(/flags=\(unconfined\)/g) ?? []).length, 2);
  assert.ok(profile.includes(`profile upload-doctor-ci-chromium-0 "${binaries[0]}"`));
  assert.ok(profile.includes(`profile upload-doctor-ci-chromium-1 "${binaries[1]}"`));
  assert.doesNotMatch(profile, /\*|@\{|capability|sysctl/);
});

test('CI AppArmor profile rejects injection, globs, aliases, and executables outside its cache', () => {
  for (const malicious of [
    `${binaries[0]}\n`,
    `${binaries[0]}\r`,
    `${binaries[0]}\0`,
    `${binaries[0]}" flags=(unconfined) { userns, }`,
    `${cache}/chromium-*/chrome-linux64/chrome`,
    `${cache}/chromium-{1243,1244}/chrome-linux64/chrome`,
    `${cache}/chromium-1243/chrome-linux64/../chrome-linux64/chrome`,
    `${cache}//chromium-1243/chrome-linux64/chrome`,
    '/usr/bin/chromium',
    `${cache}-other/chromium-1243/chrome-linux64/chrome`,
    `${cache}/chromium-1243/chrome-linux64/other`,
    `${cache}/chromium-1243/chrome-linux64/chrome/`,
    binaries[1],
  ])
    assert.throws(() => buildProfile(cache, [malicious, binaries[1]]));
  for (const maliciousCache of [
    '/home/runner*/.cache/ms-playwright',
    '/home/@{HOME}/.cache/ms-playwright',
    '/home/runner\n/.cache/ms-playwright',
    '/home/runner x/.cache/ms-playwright',
    '/home/runner/../runner/.cache/ms-playwright',
    '/home/runner/.cache/other',
    '/home/runner/.cache/ms-playwright/',
  ])
    assert.throws(() => buildProfile(maliciousCache, binaries));
  assert.throws(() => buildProfile(cache, [binaries[0]]));
  assert.throws(() => buildProfile(cache, [...binaries, '/bin/sh']));
  assert.throws(() => buildProfile(cache, 'xx'));
});

test('CI AppArmor commands reject an ordinary machine before privilege or dependency loading', () => {
  // Intercept every child process launch: host rejection must occur before any sudo call.
  const hook = `import child from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; child.execFileSync = () => { throw new Error('UNEXPECTED_PRIVILEGED_EXECUTION'); }; syncBuiltinESMExports();`;
  for (const action of ['setup', 'cleanup']) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(hook)}`,
        fileURLToPath(new URL('../scripts/ci-chromium-sandbox.mjs', import.meta.url)),
        action,
      ],
      { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a nonroot GitHub-hosted Linux x64 runner/);
    assert.doesNotMatch(
      result.stderr,
      /UNEXPECTED_PRIVILEGED_EXECUTION|playwright|ERR_MODULE_NOT_FOUND/,
    );
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('live provider harness rejects absent opt-in and unsafe configuration before network work', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('UPLOAD_DOCTOR_LIVE')),
  );
  const synthetic = {
    UPLOAD_DOCTOR_LIVE: '1',
    UPLOAD_DOCTOR_LIVE_PROVIDER: 'r2',
    UPLOAD_DOCTOR_LIVE_BUCKET: 'synthetic-test-bucket',
    UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID: 'CANARY_TEST_ACCESS',
    UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY: 'CANARY_TEST_SECRET',
  };
  for (const config of [
    {},
    synthetic,
    { ...synthetic, UPLOAD_DOCTOR_LIVE_ENDPOINT: 'https://attacker.invalid' },
    { ...synthetic, UPLOAD_DOCTOR_LIVE_ENDPOINT: 'http://127.0.0.1:43189' },
    { ...synthetic, DEBUG: '*' },
  ]) {
    const result = spawnSync(process.execPath, ['scripts/live-smoke.mjs'], {
      env: { ...env, ...config },
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Live test did not run/);
    assert.doesNotMatch(result.stderr + result.stdout, /CANARY|attacker/);
  }
});

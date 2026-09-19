import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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

test('live service endpoint configuration preserves strict provider boundaries without network work', () => {
  const source = readFileSync(new URL('../scripts/live-smoke.mjs', import.meta.url), 'utf8');
  const configOnly = source.slice(
    source.indexOf('function isS3ServiceHost('),
    source.indexOf('\nconst config = configuration();'),
  );
  const base = {
    UPLOAD_DOCTOR_LIVE: '1',
    UPLOAD_DOCTOR_LIVE_PROVIDER: 's3',
    UPLOAD_DOCTOR_LIVE_BUCKET: 'synthetic-test-bucket',
    UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID: 'CANARY_TEST_ACCESS',
    UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY: 'CANARY_TEST_SECRET',
    UPLOAD_DOCTOR_LIVE_REGION: 'us-east-1',
  };
  const configure = (endpoint) =>
    runInNewContext(
      `${configOnly}\nconfiguration();`,
      { URL, process: { env: { ...base, UPLOAD_DOCTOR_LIVE_ENDPOINT: endpoint } } },
      { timeout: 1000 },
    );
  for (const endpoint of [
    'https://s3.amazonaws.com',
    'https://s3.us-east-1.amazonaws.com',
    'https://s3-us-west-2.amazonaws.com',
    'https://s3.dualstack.us-west-2.amazonaws.com',
    'https://s3-fips.us-gov-west-1.amazonaws.com',
    'https://s3.cn-north-1.amazonaws.com.cn',
  ]) {
    assert.equal(configure(endpoint)?.endpoint, endpoint);
  }
  for (const endpoint of [
    'https://bucket.s3.us-east-1.amazonaws.com',
    'https://s3.amazonaws.com.attacker.invalid',
    'https://s3-.amazonaws.com',
    'https://s3.not_valid.amazonaws.com',
    `https://s3${'-a'.repeat(30)}.invalid`,
    `https://s3.${'a'.repeat(254)}.amazonaws.com`,
    `https://s3.${'a'.repeat(2048)}.amazonaws.com`,
  ]) {
    assert.equal(configure(endpoint), null);
  }
});

test('adversarial live endpoint configuration rejects promptly without any network sink', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('UPLOAD_DOCTOR_LIVE') && !['DEBUG', 'NODE_DEBUG', 'PWDEBUG'].includes(key),
    ),
  );
  Object.assign(env, {
    UPLOAD_DOCTOR_LIVE: '1',
    UPLOAD_DOCTOR_LIVE_PROVIDER: 's3',
    UPLOAD_DOCTOR_LIVE_BUCKET: 'synthetic-test-bucket',
    UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID: 'CANARY_TEST_ACCESS',
    UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY: 'CANARY_TEST_SECRET',
    UPLOAD_DOCTOR_LIVE_REGION: 'us-east-1',
  });
  const preload = `
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    let attempts = 0;
    const deny = () => { attempts++; throw new Error('network tripwire'); };
    net.Socket.prototype.connect = deny;
    net.Server.prototype.listen = deny;
    tls.connect = http.request = http.get = https.request = https.get = deny;
    childProcess.spawn = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
    process.on('exit',()=>process.stdout.write(JSON.stringify({attempts})));
  `;
  for (const endpoint of [
    'https://attacker.invalid',
    `https://s3${'-a'.repeat(30)}.invalid`,
    `https://s3${'-a'.repeat(1000)}.amazonaws.com.attacker.invalid`,
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
        'scripts/live-smoke.mjs',
      ],
      {
        env: { ...env, UPLOAD_DOCTOR_LIVE_ENDPOINT: endpoint },
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Live test did not run/);
    assert.doesNotMatch(result.stderr, /CANARY|attacker|tripwire/);
    assert.deepEqual(JSON.parse(result.stdout), { attempts: 0 });
  }
});

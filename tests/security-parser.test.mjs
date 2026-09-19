import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatReport,
  inspectHar,
  providerForHost,
  shareReport,
  validateReport,
} from '../dist/index.js';

test('provider recognition retains supported AWS and R2 endpoint forms', () => {
  for (const host of [
    's3.amazonaws.com',
    'bucket.s3.amazonaws.com',
    's3.us-east-1.amazonaws.com',
    'bucket.s3.us-east-1.amazonaws.com',
    'bucket.s3-us-west-2.amazonaws.com',
    'bucket.s3.dualstack.us-west-2.amazonaws.com',
    'bucket.s3-accelerate.dualstack.amazonaws.com',
    'bucket.s3-fips.us-gov-west-1.amazonaws.com',
    'bucket.s3.cn-north-1.amazonaws.com.cn',
  ]) {
    assert.equal(providerForHost(host), 's3', host);
  }
  for (const host of [
    '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com',
    '0123456789abcdef0123456789abcdef.fedramp.r2.cloudflarestorage.com',
    'bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  ]) {
    assert.equal(providerForHost(host), 'r2', host);
  }
  for (const host of [
    's3.amazonaws.com.attacker.invalid',
    's3.amazonaws.com.cn.attacker.invalid',
    's3-.amazonaws.com',
    's3..amazonaws.com',
    's3.not_valid.amazonaws.com',
    's3\n.amazonaws.com',
    'r2.cloudflarestorage.com',
    'assets.example.invalid',
  ]) {
    assert.equal(providerForHost(host), 'unknown', host);
  }
});

test('hostile HAR hostnames cannot monopolize the parser', () => {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { inspectHar, providerForHost } from ${JSON.stringify(moduleUrl)};
       const hosts = [
         's3' + '-a'.repeat(30) + '.invalid',
         's3' + '-a'.repeat(4000) + '.amazonaws.com.attacker.invalid',
         's3' + '-a'.repeat(4000) + '.not_valid.amazonaws.com',
         Array(1000).fill('s3-a').join('.') + '.not_valid.amazonaws.com',
       ];
       for (const host of hosts) {
         assert.equal(providerForHost(host), 'unknown');
         const report = inspectHar({ log: { entries: [{ request: {
           method: 'GET', url: 'https://' + host + '/asset.js', headers: [],
         }, response: { status: 200, headers: [], content: {} } }] } });
         assert.equal(report.coverage.uploadsObserved, 0);
       }
       assert.equal(providerForHost('bucket.s3.us-east-1.amazonaws.com'), 's3');
       console.log('bounded-host-parsing-passed');`,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
    },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /bounded-host-parsing-passed/);
});

test('imported report enums reject array coercions before sharing', () => {
  const report = inspectHar({
    log: {
      entries: [
        {
          startedDateTime: '2026-09-19T12:00:00Z',
          request: {
            method: 'PUT',
            url: 'https://bucket.s3.us-east-1.amazonaws.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic',
            headers: [],
          },
          response: { status: 403, headers: [], content: {} },
        },
      ],
    },
  });
  const locations = [
    (r) => [r, 'source'],
    (r) => [r, 'visibility'],
    (r) => [r.profiles[0], 'provider'],
    (r) => [r.findings[0], 'status'],
    (r) => [r.findings[0], 'confidence'],
  ];
  for (const location of locations) {
    for (const wrap of [(v) => [v], (v) => [[v]], () => null, () => ({})]) {
      const modified = structuredClone(report);
      const [parent, key] = location(modified);
      parent[key] = wrap(parent[key]);
      assert.throws(() => validateReport(modified), { name: 'InputError' });
      assert.throws(() => shareReport(modified), { name: 'InputError' });
    }
  }
  assert.deepEqual(validateReport(report), report);
  assert.deepEqual(validateReport(shareReport(report)), shareReport(report));
});

test('terminal formatting escapes controls in validated imported narratives', () => {
  const report = inspectHar({
    log: {
      entries: [
        {
          request: {
            method: 'PUT',
            url: 'https://bucket.s3.us-east-1.amazonaws.com/object',
            headers: [],
          },
          response: { status: 403, headers: [], content: {} },
        },
      ],
    },
  });
  const payload = 'audit\u001b]52;c;U1lOVEhFVElD\u0007\u001b[2J\rforged\nline\u202e';
  for (const field of ['title', 'explanation', 'recommendation']) {
    report.findings[0][field] = payload;
  }
  report.coverage.limitations = [payload, 'Ordinary narrative remains readable.'];
  const output = formatReport(validateReport(report));
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  assert.match(output, /audit\\u001b\]52;c;U1lOVEhFVElD\\u0007/);
  assert.match(output, /\\u001b\[2J\\u000dforged\\u000aline\\u202e/);
  assert.match(output, /Coverage: Ordinary narrative remains readable\.\n$/);
  assert.match(output, /^Upload Doctor 0\.1\.0\n/);
});

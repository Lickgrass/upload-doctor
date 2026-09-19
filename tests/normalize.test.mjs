import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectHar,
  normalizeHar,
  parseContract,
  providerForHost,
  createReport,
  reportExitCode,
} from '../dist/index.js';
import { contract, entry, endpoint, har, headers, signedUrl } from './helpers.mjs';

test('HAR import retains evidence, never credentials, names, bodies or response text in reports', () => {
  const report = inspectHar(har(), { contract });
  assert.equal(report.coverage.uploadsObserved, 1);
  assert.equal(report.profiles[0].origin, 'https://app.example');
  assert.equal(report.uploads[0].applicationSuccess, null);
  assert.doesNotMatch(JSON.stringify(report), /CANARY_|X-Amz-/);
  assert.equal(report.profiles[0].destination, 'private-bucket');
  assert.equal(report.source, 'har');
});
test('normalization drops unknown header values and never marks ordinary HAR headers complete', () => {
  const r = normalizeHar(har()).requests[0];
  assert.equal(r.headers.authorization, '');
  assert.equal(r.headers.cookie, '');
  assert.equal(r.responseHeaders['set-cookie'], '');
  assert.equal(r.headersComplete, false);
  assert.equal(r.endpoint, endpoint);
  assert.equal(r.signedAt, '2026-09-19T12:00:00.000Z');
  assert.equal(r.expiresSeconds, 300);
  assert.equal(r.provider, 'r2');
});
test('untrusted HAR browser extension cannot forge completion or header completeness', () => {
  const input = har(
    entry({
      _uploadDoctor: {
        headersComplete: true,
        browserCompleted: true,
        applicationSuccess: true,
        applicationAssertion: 'success',
        bodyKind: 'form-data',
      },
    }),
  );
  const evidence = normalizeHar(input);
  assert.equal(evidence.requests[0].headersComplete, false);
  assert.equal(evidence.requests[0].applicationSuccess, null);
  assert.equal(evidence.requests[0].browserCompleted, null);
  assert.equal(evidence.requests[0].bodyKind, 'raw');
});
test('explicit browser collector can retain richer evidence', () => {
  const input = har(
    entry({
      _uploadDoctor: {
        headersComplete: true,
        responseHeadersComplete: true,
        browserCompleted: true,
        applicationSuccess: true,
        applicationAssertion: 'success',
      },
    }),
  );
  const evidence = normalizeHar(input, contract, { trustedBrowser: true });
  assert.equal(evidence.source, 'browser');
  assert.equal(evidence.requests[0].headersComplete, true);
  assert.equal(evidence.requests[0].applicationSuccess, true);
});
test('a confirmed browser transport failure cannot yield no-failure exit semantics', () => {
  const input = har(
    entry({
      response: { status: 0, headers: [], content: {} },
      _uploadDoctor: { headersComplete: true, browserCompleted: false },
    }),
  );
  const report = inspectHar(input);
  assert.equal(report.findings.find((f) => f.ruleId === 'browser-outcome').status, 'unknown');
  const evidence = normalizeHar(input, contract, { trustedBrowser: true });
  assert.equal(evidence.requests[0].browserCompleted, false);
  const captured = createReport(evidence, contract);
  assert.equal(captured.findings.find((f) => f.ruleId === 'browser-outcome').status, 'fail');
  assert.equal(reportExitCode(captured), 1);
});
test('recognizes provider errors, discards messages, and rejects unrecognized or encoded XML code', () => {
  for (const encoding of [undefined, 'base64']) {
    const text = '<Error><Code>ExpiredRequest</Code><Message>CANARY_SECRET</Message></Error>';
    const content = encoding ? { encoding, text: Buffer.from(text).toString('base64') } : { text };
    const data = har(entry({ response: { status: 403, headers: [], content } }));
    assert.equal(normalizeHar(data).requests[0].providerCode, 'ExpiredRequest');
    assert.doesNotMatch(JSON.stringify(inspectHar(data)), /CANARY/);
  }
  assert.equal(
    normalizeHar(
      har(entry({ response: { status: 403, content: { text: '<Code>CANARY_SECRET</Code>' } } })),
    ).requests[0].providerCode,
    null,
  );
});
test('FormData requires observed boundary evidence, not Content-Type alone', () => {
  const original = entry();
  const ct = 'multipart/form-data; boundary=abc';
  const make = (text) =>
    har(
      entry({
        request: {
          ...original.request,
          headers: headers({ 'content-type': ct, origin: 'https://app.example' }),
          postData: { mimeType: ct, ...(text === undefined ? {} : { text }) },
        },
      }),
    );
  assert.equal(normalizeHar(make(undefined)).requests[0].bodyKind, 'unknown');
  assert.equal(
    normalizeHar(make('--abc\r\nContent-Disposition: form-data; name="file"\r\n')).requests[0]
      .bodyKind,
    'form-data',
  );
  assert.equal(normalizeHar(make('ordinary bytes')).requests[0].bodyKind, 'unknown');
});
test('preflight correlation requires same URL, origin, method and nearby previous time', () => {
  const preflight = entry({
    startedDateTime: '2026-09-19T12:00:59.000Z',
    request: {
      url: signedUrl(),
      method: 'OPTIONS',
      headers: headers({
        origin: 'https://app.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      }),
    },
    response: {
      status: 204,
      headers: headers({
        'access-control-allow-origin': 'https://app.example',
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': 'content-type',
      }),
    },
  });
  assert.equal(normalizeHar(har(preflight, entry())).requests[0].preflight.status, 204);
  assert.equal(
    normalizeHar(har({ ...preflight, startedDateTime: '2026-09-19T11:00:00Z' }, entry()))
      .requests[0].preflight,
    null,
  );
  assert.equal(normalizeHar(har(entry(), preflight)).requests[0].preflight, null);
});
test('provider recognition excludes hostname lookalikes; explicit contracts scope custom hosts', () => {
  assert.equal(providerForHost('bucket.s3.us-east-1.amazonaws.com'), 's3');
  assert.equal(providerForHost('bucket.s3.amazonaws.com.attacker.example'), 'unknown');
  assert.equal(
    normalizeHar(
      har(entry({ request: { ...entry().request, url: 'https://attacker.example/upload' } })),
    ).requests.length,
    0,
  );
  const custom = { version: 1, id: 'test', storageHosts: ['127.0.0.1'], provider: 'r2' };
  const url = new URL(signedUrl());
  url.hostname = '127.0.0.1';
  url.port = '3333';
  assert.equal(
    normalizeHar(har(entry({ request: { ...entry().request, url: url.href } })), custom).requests[0]
      .provider,
    'r2',
  );
});
test('duplicates, invalid dates and malformed entries never become validity passes', () => {
  const duplicate = signedUrl() + '&X-Amz-Expires=999';
  assert.equal(
    normalizeHar(har(entry({ request: { ...entry().request, url: duplicate } }))).requests[0]
      .signatureVersion,
    null,
  );
  assert.equal(
    normalizeHar(
      har(
        entry({
          request: { ...entry().request, url: signedUrl({ 'X-Amz-Date': '20260231T120000Z' }) },
        }),
      ),
    ).requests[0].signedAt,
    null,
  );
  const invalid = normalizeHar(
    har(null, { request: { url: 'file:///etc/passwd', method: 'PUT' } }),
  );
  assert.equal(invalid.requests.length, 0);
  assert.ok(invalid.limitations.length);
  assert.equal(invalid.truncated, true);
  assert.throws(() => normalizeHar({ log: { entries: 'bad' } }), /Invalid HAR/);
});
test('omitted malformed entries make mixed captures incomplete', () => {
  const good = entry();
  const bad = entry({ request: { ...good.request, method: 'put' } });
  const report = inspectHar(har(good, bad));
  assert.equal(report.coverage.truncated, true);
  assert.equal(report.coverage.uploadsObserved, 1);
});
test('destination excludes object keys and distinguishes path-style buckets and virtual hosts', () => {
  const original = entry();
  for (const [url, destination] of [
    ['https://s3.us-east-1.amazonaws.com/first/private/key', 'first'],
    ['https://first.s3.us-east-1.amazonaws.com/private/key', 'first.s3.us-east-1.amazonaws.com'],
    [
      'https://s3-team.s3.us-east-1.amazonaws.com/CANARY_PRIVATE_FILE',
      's3-team.s3.us-east-1.amazonaws.com',
    ],
    ['https://s3-us-west-2.amazonaws.com/first/CANARY_PRIVATE_FILE', 'first'],
    [endpoint + '/first/private/key', 'first'],
    [endpoint + '/second/private/key', 'second'],
  ]) {
    assert.equal(
      normalizeHar(
        har(
          entry({
            request: { ...original.request, url: url + '?' + new URL(signedUrl()).searchParams },
          }),
        ),
      ).requests[0].destination,
      destination,
    );
  }
});
test('input caps report incomplete coverage, never silently successful', () => {
  const data = { log: { entries: Array.from({ length: 10001 }, () => entry()) } };
  const evidence = normalizeHar(data);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.requests.length, 1000);
});
test('contracts are strict, bounded, normalized and reject credential-oriented fields', () => {
  assert.deepEqual(
    parseContract({ ...contract, storageHosts: contract.storageHosts.map((v) => v.toUpperCase()) }),
    contract,
  );
  for (const bad of [
    { ...contract, secretAccessKey: 'secret' },
    { ...contract, storageHosts: ['https://example.com'] },
    { ...contract, storageHosts: ['user:pass@example.com'] },
    { ...contract, contentType: 'text/plain\nAuthorization: secret' },
    { ...contract, requiredResponseHeaders: ['set-cookie'] },
    { ...contract, id: '../file' },
    { ...contract, method: 'POST' },
  ])
    assert.throws(() => parseContract(bad));
});

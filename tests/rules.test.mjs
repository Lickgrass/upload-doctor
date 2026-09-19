import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, RULE_IDS } from '../dist/rules.js';
import { contract, finding, findings, preflight, request } from './rules-helpers.mjs';

test('supports only known single query-presigned SigV4 PUT uploads', () => {
  assert.equal(finding('upload-scope').status, 'pass');
  for (const patch of [
    { provider: 'unknown' },
    { signatureVersion: null },
    { signatureVersion: 'AWS4-ECDSA-P256-SHA256' },
    { multipart: true },
    { method: 'POST' },
    { endpoint: 'not-a-url' },
    { endpoint: 'file:///tmp/test' },
  ]) {
    assert.equal(finding('upload-scope', patch).status, 'unsupported');
    assert.equal(
      findings(patch).some((item) => item.ruleId === 'provider-rejection'),
      false,
    );
  }
});

test('contract method mismatch gives a correction while preserving unsupported POST scope', () => {
  assert.equal(finding('contract-method', { method: 'POST' }).status, 'fail');
  assert.equal(finding('contract-method').status, 'pass');
  const otherHost = { ...contract, storageHosts: ['different.example'] };
  assert.equal(
    findings({ method: 'POST' }, otherHost).some((item) => item.ruleId === 'contract-method'),
    false,
  );
});

test('R2 custom endpoint is rejected only with established provider identity', () => {
  assert.equal(
    finding('r2-endpoint', { provider: 'r2', endpoint: 'https://uploads.example/file' }).status,
    'fail',
  );
  assert.equal(
    finding('r2-endpoint', {
      provider: 'r2',
      endpoint: 'https://account.r2.cloudflarestorage.com/bucket/file',
    }).status,
    'pass',
  );
  assert.equal(
    finding('r2-endpoint', {
      provider: 'r2',
      endpoint: 'https://account.eu.r2.cloudflarestorage.com/bucket/file',
    }).status,
    'pass',
  );
  assert.equal(
    findings({ provider: 'unknown', endpoint: 'https://uploads.example/file' }).some(
      (item) => item.ruleId === 'r2-endpoint',
    ),
    false,
  );
  assert.equal(
    findings().some((item) => item.ruleId === 'r2-endpoint'),
    false,
  );
});

test('Content-Type mismatch needs contract evidence and missing headers need completeness', () => {
  assert.equal(
    finding('contract-content-type', { headers: { 'content-type': 'text/plain' } }).status,
    'fail',
  );
  assert.equal(finding('contract-content-type').status, 'pass');
  assert.equal(finding('contract-content-type', { headers: {} }).status, 'fail');
  assert.equal(
    finding('contract-content-type', { headers: {}, headersComplete: false }).status,
    'unknown',
  );
  assert.equal(
    finding('contract-content-type', { headers: { 'Content-Type': 'image/png' } }).status,
    'pass',
  );
  assert.equal(finding('contract-content-type', {}, null).status, 'unknown');
});

test('host and provider scope prevent using unrelated contracts', () => {
  const unrelated = {
    ...contract,
    storageHosts: ['other.example'],
    contentType: 'secret-contract-value',
  };
  assert.equal(finding('contract-content-type', {}, unrelated).status, 'unknown');
  assert.equal(
    finding('contract-content-type', {}, { ...contract, provider: 'r2' }).status,
    'unknown',
  );
  assert.equal(
    finding(
      'contract-content-type',
      {},
      { ...contract, storageHosts: ['BUCKET.S3.US-EAST-1.AMAZONAWS.COM'] },
    ).status,
    'pass',
  );
});

test('FormData raw-body mismatch remains a failure even after storage accepted it', () => {
  const bad = finding('contract-body', { bodyKind: 'form-data' });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.confidence, 'confirmed');
  assert.equal(finding('contract-body').status, 'pass');
  assert.equal(finding('contract-body', { bodyKind: 'unknown' }).status, 'unknown');
  assert.equal(finding('contract-body', { bodyKind: 'form-data' }, null).confidence, 'likely');
  assert.equal(
    finding('contract-body', { bodyKind: 'form-data' }, { ...contract, body: 'any' }).status,
    'pass',
  );
});

test('signed header presence respects incomplete captures and implicit Host', () => {
  assert.equal(finding('signed-headers', { headers: {} }).status, 'fail');
  assert.equal(finding('signed-headers').status, 'pass');
  assert.equal(finding('signed-headers', { signedHeaders: ['host'], headers: {} }).status, 'pass');
  assert.equal(
    finding('signed-headers', { headers: {}, headersComplete: false }).status,
    'unknown',
  );
  assert.equal(finding('signed-headers', { signedHeaders: [] }).status, 'unknown');
  assert.equal(
    finding('signed-headers', {
      signedHeaders: ['host', 'x-meta-private'],
      headers: { 'X-Meta-Private': '' },
    }).status,
    'pass',
  );
});

test('expired R2 URL is a confirmed cause even when the browser reports CORS', () => {
  const bad = {
    provider: 'r2',
    endpoint: 'https://account.r2.cloudflarestorage.com/bucket/file',
    status: 403,
    providerCode: 'ExpiredRequest',
    browserCompleted: false,
    browserCorsError: true,
    responseHeaders: {},
  };
  assert.equal(finding('url-expiry', bad).status, 'fail');
  assert.equal(finding('url-expiry', bad).confidence, 'confirmed');
  assert.match(finding('url-expiry', bad).explanation, /secondary/);
  assert.equal(finding('cors-origin', bad).status, 'fail');
  assert.match(
    finding('cors-origin', bad).explanation,
    /bucket misconfiguration is not established/,
  );
  assert.equal(finding('url-expiry', { ...bad, providerCode: null, status: 200 }).status, 'pass');
  assert.equal(finding('url-expiry', { browserCorsError: true }).status, 'pass');
});

test('nominal URL timing is a bounded likely finding and never uses capture time', () => {
  const late = finding('url-expiry', { startedAt: '2026-09-19T12:06:00Z' });
  assert.equal(late.status, 'fail');
  assert.equal(late.confidence, 'likely');
  assert.equal(finding('url-expiry').status, 'pass');
  assert.equal(finding('url-expiry', { startedAt: '2026-09-19T11:59:00Z' }).confidence, 'likely');
  for (const patch of [
    { startedAt: null },
    { signedAt: null },
    { expiresSeconds: null },
    { expiresSeconds: Infinity },
    { expiresSeconds: -1 },
    { expiresSeconds: 604801 },
    { startedAt: 'invalid' },
  ]) {
    assert.equal(finding('url-expiry', patch).status, 'unknown');
  }
});

test('ExpiredToken overrides assumptions about advertised URL validity', () => {
  const bad = { providerCode: 'ExpiredToken', status: 403, temporaryCredentials: true };
  assert.equal(finding('credential-expiry', bad).status, 'fail');
  assert.equal(finding('credential-expiry', bad).confidence, 'confirmed');
  assert.equal(finding('url-expiry', bad).status, 'pass');
  assert.equal(finding('credential-expiry', { temporaryCredentials: true }).status, 'pass');
  assert.equal(finding('credential-expiry').status, 'pass');
  assert.equal(
    finding('credential-expiry', { temporaryCredentials: true, status: null }).status,
    'unknown',
  );
  assert.equal(
    finding('credential-expiry', { status: 403, providerCode: 'AccessDenied' }).status,
    'unknown',
  );
});

test('provider authorization and signature errors do not invent exact causes', () => {
  for (const code of ['AccessDenied', 'SignatureDoesNotMatch']) {
    const bad = finding('provider-rejection', { status: 403, providerCode: code });
    assert.equal(bad.status, 'fail');
    assert.match(bad.title, /unknown/);
  }
  assert.equal(finding('provider-rejection').status, 'pass');
  assert.equal(
    finding('provider-rejection', { status: 403, providerCode: null }).confidence,
    'unknown',
  );
  assert.equal(
    finding('provider-rejection', { status: null, browserCorsError: true }).status,
    'unknown',
  );
});

test('checksum rejection is distinct from generic errors and SDK compatibility guessing', () => {
  for (const code of [
    'BadDigest',
    'InvalidDigest',
    'ChecksumMismatch',
    'XAmzContentSHA256Mismatch',
  ]) {
    const bad = finding('provider-rejection', { status: 400, providerCode: code });
    assert.equal(bad.status, 'fail');
    assert.match(bad.title, /integrity/);
  }
  assert.equal(finding('provider-rejection').status, 'pass');
  assert.doesNotMatch(
    finding('provider-rejection', { status: 400, providerCode: 'NotImplemented' }).title,
    /integrity/,
  );
});

test('failed preflight is observed without inferring a bucket policy cause', () => {
  const bad = finding('cors-preflight', { preflight: preflight({ status: 403 }) });
  assert.equal(bad.status, 'fail');
  assert.match(bad.explanation, /does not/);
  assert.equal(finding('cors-preflight').status, 'pass');
  assert.equal(finding('cors-preflight', { preflight: null }).status, 'unknown');
  assert.equal(
    finding('cors-preflight', { preflight: preflight({ status: null }) }).status,
    'unknown',
  );
});

test('CORS origin checks distinguish explicit mismatch, complete absence and missing evidence', () => {
  const bad = {
    browserCompleted: false,
    responseHeaders: { 'access-control-allow-origin': 'https://wrong.example' },
  };
  assert.equal(finding('cors-origin', bad).status, 'fail');
  assert.equal(finding('cors-origin').status, 'pass');
  assert.equal(
    finding('cors-origin', { browserCompleted: false, responseHeaders: {} }).status,
    'fail',
  );
  assert.equal(
    finding('cors-origin', {
      browserCompleted: null,
      responseHeaders: {},
      responseHeadersComplete: false,
      preflight: null,
    }).status,
    'unknown',
  );
  assert.equal(
    finding('cors-origin', { browserCompleted: null, origin: null, preflight: null }).status,
    'unknown',
  );
  assert.equal(
    finding('cors-origin', {
      browserCompleted: null,
      responseHeaders: { 'access-control-allow-origin': '*' },
      preflight: null,
    }).status,
    'unknown',
  );
  assert.equal(
    finding('cors-origin', {
      responseHeaders: { 'access-control-allow-origin': '*' },
      preflight: null,
    }).status,
    'pass',
  );
});

test('a preflight origin mismatch is checked even if no actual PUT response exists', () => {
  const blocked = {
    status: null,
    browserCompleted: false,
    preflight: preflight({ headers: { 'access-control-allow-origin': 'https://wrong.example' } }),
  };
  assert.equal(finding('cors-origin', blocked).status, 'fail');
  assert.equal(
    finding('cors-origin', {
      ...blocked,
      preflight: preflight(),
      status: 200,
      browserCompleted: true,
    }).status,
    'pass',
  );
  assert.equal(
    finding('cors-origin', {
      ...blocked,
      preflight: preflight({ headers: {}, headersComplete: false }),
    }).status,
    'unknown',
  );
});

test('method and header permission mismatches have fixed, repaired and incomplete controls', () => {
  for (const [rule, permission, wrongValue, rightValue] of [
    ['cors-method', 'access-control-allow-methods', 'GET', 'PUT'],
    ['cors-headers', 'access-control-allow-headers', 'x-other-header', 'Content-Type'],
  ]) {
    assert.equal(
      finding(rule, {
        browserCompleted: false,
        preflight: preflight({ headers: { [permission]: wrongValue } }),
      }).status,
      'fail',
    );
    assert.equal(
      finding(rule, {
        browserCompleted: false,
        preflight: preflight({ headers: { [permission]: rightValue } }),
      }).status,
      'pass',
    );
    assert.equal(
      finding(rule, {
        browserCompleted: false,
        preflight: preflight({ headers: {}, headersComplete: true }),
      }).status,
      'fail',
    );
    assert.equal(
      finding(rule, {
        browserCompleted: null,
        preflight: preflight({ headers: {}, headersComplete: false }),
      }).status,
      'unknown',
    );
    assert.equal(
      finding(rule, {
        browserCompleted: null,
        preflight: preflight({ headers: { [permission]: '*' } }),
      }).status,
      'unknown',
    );
    assert.equal(finding(rule, { browserCompleted: null, preflight: null }).status, 'unknown');
  }
  assert.equal(
    finding('cors-method', {
      browserCompleted: false,
      preflight: preflight({ headers: { 'access-control-allow-methods': 'put' } }),
    }).status,
    'fail',
  );
});

test('same-origin flow does not need CORS permissions', () => {
  for (const rule of ['cors-preflight', 'cors-origin', 'cors-method', 'cors-headers']) {
    assert.equal(
      finding(rule, {
        origin: 'https://bucket.s3.us-east-1.amazonaws.com',
        preflight: null,
        responseHeaders: {},
      }).status,
      'pass',
    );
  }
});

test('required response header is confirmed unreadable only from direct accepted-upload evidence', () => {
  assert.equal(
    finding('response-header-access', { responseHeaderAccess: { etag: false } }).status,
    'fail',
  );
  assert.equal(
    finding('response-header-access', { responseHeaderAccess: { etag: false } }).confidence,
    'confirmed',
  );
  assert.equal(finding('response-header-access').status, 'pass');
  assert.equal(
    finding('response-header-access', { responseHeaderAccess: { etag: false }, status: 403 })
      .status,
    'unknown',
  );
  assert.equal(finding('response-header-access', { responseHeaderAccess: null }).status, 'unknown');
  assert.equal(finding('response-header-access', {}, null).status, 'unknown');
});

test('missing ETag exposure is inferred carefully and direct browser evidence is needed to prove correction', () => {
  const inferred = {
    responseHeaderAccess: null,
    responseHeaders: { etag: '', 'access-control-allow-origin': 'https://app.example' },
  };
  assert.equal(finding('response-header-access', inferred).status, 'fail');
  assert.equal(finding('response-header-access', inferred).confidence, 'likely');
  assert.equal(
    finding('response-header-access', { ...inferred, responseHeaderAccess: { etag: true } }).status,
    'pass',
  );
  assert.equal(
    finding('response-header-access', { ...inferred, responseHeadersComplete: false }).status,
    'unknown',
  );
  assert.equal(
    finding('response-header-access', {
      ...inferred,
      responseHeaders: { ...inferred.responseHeaders, 'access-control-expose-headers': '*' },
    }).status,
    'unknown',
  );
  assert.equal(finding('response-header-access', { ...inferred, origin: null }).status, 'unknown');
  assert.equal(
    finding('response-header-access', inferred, {
      ...contract,
      requiredResponseHeaders: ['Content-Type'],
    }).status,
    'unknown',
  );
});

test('redirect and explicit region errors prompt re-signing without guessing a destination', () => {
  for (const patch of [
    { status: 307, redirectRegion: 'sensitive-value' },
    { providerCode: 'IncorrectEndpoint', status: 400 },
  ]) {
    const bad = finding('region-redirect', patch);
    assert.equal(bad.status, 'fail');
    assert.equal(bad.confidence, 'likely');
    assert.doesNotMatch(JSON.stringify(bad), /sensitive-value/);
  }
  assert.equal(finding('region-redirect').status, 'pass');
  assert.equal(finding('region-redirect', { status: null }).status, 'unknown');
});

test('a region header alone never diagnoses an endpoint mismatch', () => {
  assert.equal(finding('region-redirect', { redirectRegion: 'us-west-2' }).status, 'pass');
  assert.equal(
    finding('region-redirect', {
      redirectRegion: 'us-west-2',
      status: 403,
      providerCode: 'AccessDenied',
    }).status,
    'pass',
  );
  assert.equal(
    finding('region-redirect', { redirectRegion: 'us-west-2', status: null }).status,
    'unknown',
  );
});

test('stored-byte integrity remains unknown despite successful HTTP, ETag and application evidence', () => {
  assert.equal(finding('body-integrity').status, 'unknown');
  assert.equal(
    finding('body-integrity', { status: 403, applicationSuccess: false }).status,
    'unknown',
  );
});

test('diagnostic narrative never echoes untrusted input values, names or URLs', () => {
  const secret = 'SECRET_VALUE_DO_NOT_ECHO';
  const malicious = {
    headers: { 'content-type': secret, [secret]: secret },
    responseHeaders: { 'access-control-allow-origin': secret, [secret]: secret },
    signedHeaders: ['host', secret],
    providerCode: secret,
    responseHeaderAccess: { [secret]: false },
    redirectRegion: secret,
    bodyKind: 'form-data',
    status: 403,
    browserCompleted: false,
    applicationAssertion: secret,
    preflight: preflight({
      requestedHeaders: [secret],
      headers: { 'access-control-allow-headers': 'x-other', 'access-control-allow-origin': secret },
    }),
  };
  const result = findings(malicious, {
    ...contract,
    id: secret,
    requiredResponseHeaders: [secret],
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.equal(
    result.every((item) => RULE_IDS.includes(item.ruleId)),
    true,
  );
  assert.equal(result.length <= RULE_IDS.length, true);
});

test('multiple requests remain isolated and output is deterministic', () => {
  const evidence = {
    source: 'har',
    capturedAt: '2026-09-19T12:02:00Z',
    limitations: [],
    truncated: false,
    requests: [request({ id: 'one', bodyKind: 'form-data' }), request({ id: 'two' })],
  };
  const result = diagnose(evidence, contract);
  assert.deepEqual(result, diagnose(evidence, contract));
  assert.equal(
    result.find((item) => item.requestId === 'one' && item.ruleId === 'contract-body').status,
    'fail',
  );
  assert.equal(
    result.find((item) => item.requestId === 'two' && item.ruleId === 'contract-body').status,
    'pass',
  );
  assert.deepEqual(diagnose({ ...evidence, requests: [] }, contract), []);
});

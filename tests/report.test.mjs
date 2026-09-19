import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareReports,
  createReport,
  inspectHar,
  normalizeHar,
  reportExitCode,
  shareReport,
  validateReport,
} from '../dist/index.js';
import { contract, entry, har, headers } from './helpers.mjs';

function pair() {
  const make = (later) => {
    const request = entry();
    const input = har(
      entry({
        startedDateTime: later ? '2026-09-19T12:02:00Z' : '2026-09-19T12:01:00Z',
        request: {
          ...request.request,
          headers: headers({
            origin: 'https://app.example',
            'content-type': later ? 'text/plain' : 'image/png',
          }),
        },
        _uploadDoctor: {
          headersComplete: true,
          responseHeadersComplete: true,
          browserCompleted: true,
          applicationAssertion: 'avatar-saved',
          applicationSuccess: later,
        },
      }),
    );
    return createReport(normalizeHar(input, contract, { trustedBrowser: true }), contract);
  };
  return [make(false), make(true)];
}
test('comparison verifies a repaired contract failure with fresh browser + application assertion', () => {
  const [before, after] = pair();
  const result = compareReports(before, after);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.resolvedRules, ['contract-content-type']);
});
test('200 does not prove app completion; absent assertion yields improved only', () => {
  const [before, after] = pair();
  after.uploads[0].applicationSuccess = null;
  assert.equal(compareReports(before, after).status, 'improved');
  after.uploads[0].applicationSuccess = true;
  after.uploads[0].browserCompleted = null;
  assert.equal(compareReports(before, after).status, 'improved');
});
test('scope, origin, contract, time, coverage and source constrain verification', () => {
  const edits = [
    (a) => (a.profiles[0].origin = 'https://different.example'),
    (a) => (a.profiles[0].endpoint = 'https://different.example'),
    (a) => (a.capturedAt = '2026-09-19T12:00:00Z'),
    (a) => (a.coverage.truncated = true),
    (a) => {
      a.profiles[0].contractDigest = null;
    },
    (a) => (a.source = 'har'),
    (a) => (a.profiles[0].applicationAssertion = 'different'),
  ];
  for (const edit of edits) {
    const [b, a] = pair();
    edit(a);
    assert.notEqual(compareReports(b, a).status, 'verified');
  }
});
test('missing finding and unknown do not count as a repaired check', () => {
  for (const kind of ['missing', 'unknown']) {
    const [before, after] = pair();
    const f = after.findings.find((f) => f.ruleId === 'contract-content-type');
    if (kind === 'unknown') f.status = 'unknown';
    else after.findings = after.findings.filter((f) => f !== f);
    assert.equal(compareReports(before, after).status, 'unknown');
  }
});
test('remaining failure produces not-fixed; no earlier failure is inconclusive', () => {
  const [before, after] = pair();
  const earlier = structuredClone(before);
  earlier.capturedAt = '2026-09-19T12:00:30Z';
  earlier.profiles[0].requestStartedAt = '2026-09-19T12:00:30.000Z';
  assert.equal(compareReports(earlier, before).status, 'not-fixed');
  assert.equal(
    compareReports(after, { ...after, capturedAt: '2026-09-19T12:03:00Z' }).status,
    'unknown',
  );
});
test('later report generation cannot turn an older upload into repair verification', () => {
  const [before, after] = pair();
  after.capturedAt = '2026-09-19T12:10:00Z';
  after.profiles[0].requestStartedAt = '2026-09-19T12:00:00.000Z';
  assert.equal(compareReports(before, after).status, 'unknown');
});
test('same endpoint and contract cannot verify a different bucket', () => {
  const [before, after] = pair();
  after.profiles[0].destination = 'different-bucket';
  assert.equal(compareReports(before, after).status, 'unknown');
});
test('missing baseline rules or contradictory supported status cannot verify repairs', () => {
  const [before, after] = pair();
  after.findings = after.findings.filter((f) => f.ruleId === 'contract-content-type');
  assert.equal(compareReports(before, after).status, 'unknown');
  const [b, a] = pair();
  a.findings.find((f) => f.ruleId === 'upload-scope').status = 'unsupported';
  assert.equal(compareReports(b, a).status, 'unknown');
});
test('createReport never binds unrelated contracts to evidence', () => {
  const evidence = normalizeHar(har(), contract, { trustedBrowser: true });
  const report = createReport(evidence, { ...contract, storageHosts: ['other.example'] });
  assert.equal(report.profiles[0].contractId, null);
  assert.equal(report.profiles[0].contractDigest, null);
});
test('share drops private identities, hashes and every untrusted free text field', () => {
  const [before] = pair();
  before.findings[0].title = 'CANARY_BEARER_SECRET';
  before.findings[0].evidence = ['CANARY_BEARER_SECRET'];
  before.findings[0].explanation = 'CANARY_BEARER_SECRET';
  before.findings[0].recommendation = 'CANARY_BEARER_SECRET';
  before.findings[0].source = 'https://evil.example/CANARY_BEARER_SECRET';
  before.coverage.limitations = ['CANARY_BEARER_SECRET'];
  before.toolVersion = '0.1.0-CANARY_BEARER_SECRET'.replaceAll('_', '-');
  const shared = shareReport(before);
  const json = JSON.stringify(shared);
  assert.doesNotMatch(json, /CANARY|app\.example|cloudflarestorage|avatar|[a-f0-9]{64}/);
  assert.equal(shared.visibility, 'share');
  assert.equal(compareReports(shared, before).status, 'unknown');
  assert.deepEqual(shareReport(shared), shared);
});
test('report import rejects malformed identity/outcome/versions and duplicated evidence', () => {
  const [report] = pair();
  assert.deepEqual(validateReport(report), report);
  for (const edit of [
    (r) => (r.schemaVersion = 2),
    (r) => r.uploads.push(r.uploads[0]),
    (r) => (r.profiles[0].origin = 'https://user:pass@example.com'),
    (r) => r.findings.push(r.findings[0]),
    (r) => (r.findings[0].ruleId = 'forged'),
    (r) => (r.coverage.uploadsObserved = 999),
  ]) {
    const r = structuredClone(report);
    edit(r);
    assert.throws(() => validateReport(r));
  }
});
test('exit codes separate failures, no uploads, unknown strict coverage and ordinary no-failure', () => {
  const [before, after] = pair();
  assert.equal(reportExitCode(before), 1);
  assert.equal(reportExitCode(after), 0);
  assert.equal(reportExitCode(after, true), 3);
  assert.equal(reportExitCode(inspectHar({ log: { entries: [] } })), 3);
  assert.equal(reportExitCode({ ...after, coverage: { ...after.coverage, truncated: true } }), 3);
  assert.equal(
    reportExitCode(
      inspectHar(
        har(
          entry({ request: { ...entry().request, url: entry().request.url + '&uploadId=part' } }),
        ),
      ),
    ),
    3,
  );
});

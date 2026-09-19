import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { attachCapture, startCapture } from '../../dist/browser.js';
import { createReport, compareReports, shareReport } from '../../dist/index.js';

let browser;
let application;
let storage;
let appUrl;
let storageUrl;
let puts = 0;
const contract = {
  version: 1,
  id: 'synthetic-upload',
  storageHosts: ['localhost'],
  provider: 's3',
  pathStyle: true,
  method: 'PUT',
  body: 'raw',
};

async function server(handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  return instance;
}

before(async () => {
  application = await server((request, response) => {
    if (request.url === '/sw.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (event.request.method === 'PUT') event.respondWith(new Response('', { status: 200 }));
        });`);
      return;
    }
    if (request.url === '/sign') {
      const url = new URL(`${storageUrl}/fixture-bucket/ok`);
      url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
      url.searchParams.set('X-Amz-Signature', 'SYNTHETIC_NOT_A_REAL_SIGNATURE');
      url.searchParams.set(
        'X-Amz-Date',
        new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}/, ''),
      );
      url.searchParams.set('X-Amz-Expires', '600');
      url.searchParams.set('X-Amz-SignedHeaders', 'host');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ url: url.href }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Synthetic upload fixture</title><p>Local fixture</p>');
  });
  appUrl = `http://127.0.0.1:${application.address().port}`;
  storage = await server(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.replace(/^\/fixture-bucket/, '');
    if (request.method === 'OPTIONS') {
      if (path === '/cors') {
        response.writeHead(403, { 'Content-Type': 'application/xml', 'Content-Length': '0' });
      } else {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': appUrl,
          'Access-Control-Allow-Methods': 'PUT',
          'Access-Control-Allow-Headers': 'content-type,x-amz-meta-token',
          'Access-Control-Max-Age': '0',
        });
      }
      response.end();
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405);
      response.end();
      return;
    }
    puts += 1;
    for await (const _chunk of request) {
      /* Consume only synthetic fixture bytes. */
    }
    if (path === '/delayed') await new Promise((resolve) => setTimeout(resolve, 200));
    if (path.startsWith('/expired')) {
      const body =
        '<Error><Code>ExpiredRequest</Code><Message>PRIVATE_PROVIDER_MESSAGE</Message></Error>';
      response.setHeader('Content-Type', 'application/xml');
      response.setHeader('Content-Length', Buffer.byteLength(body));
      if (path === '/expired-readable') response.setHeader('Access-Control-Allow-Origin', appUrl);
      response.writeHead(403);
      response.end(body);
    } else if (path === '/unbounded') {
      response.writeHead(403, {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': appUrl,
      });
      response.write('<Error><Code>ExpiredRequest</Code>');
      response.end('</Error>');
    } else {
      response.writeHead(200, { 'Access-Control-Allow-Origin': appUrl, ETag: 'synthetic-etag' });
      response.end();
    }
  });
  storageUrl = `http://localhost:${storage.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await Promise.all(
    [application, storage]
      .filter(Boolean)
      .map((instance) => new Promise((resolve) => instance.close(resolve))),
  );
});

async function withCapture(fn, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const collector = await attachCapture(page, { contract, ...options });
  try {
    await page.goto(appUrl);
    return await fn(page, collector);
  } finally {
    await collector.finish();
    await context.close();
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected browser capture event did not arrive.');
}

async function upload(page, path, form = false) {
  return page.evaluate(
    async ({ url, form }) => {
      try {
        const body = form ? new FormData() : 'SYNTHETIC_FILE_BODY';
        if (form) body.append('file', 'SYNTHETIC_FILE_BODY');
        const response = await fetch(url, {
          method: 'PUT',
          body,
          headers: form
            ? {}
            : { 'Content-Type': 'text/plain', 'x-amz-meta-token': 'PRIVATE_HEADER_VALUE' },
        });
        await response.arrayBuffer();
        return { status: response.status, etag: response.headers.get('etag') };
      } catch {
        return { failed: true };
      }
    },
    {
      url: `${storageUrl}/fixture-bucket${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=PRIVATE_SIGNED_URL_VALUE&X-Amz-Date=20200101T000000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host`,
      form,
    },
  );
}

test('captures actual origin, causal preflight, storage acceptance, and honest application uncertainty', async () => {
  await withCapture(async (page, collector) => {
    const result = await upload(page, '/ok');
    assert.equal(result.status, 200);
    assert.equal(result.etag, null, 'unexposed ETag is not readable by application JavaScript');
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.source, 'browser');
    assert.equal(evidence.requests.length, 1);
    const request = evidence.requests[0];
    assert.equal(request.origin, appUrl);
    assert.equal(request.endpoint, storageUrl);
    assert.equal(request.status, 200);
    assert.equal(request.browserCompleted, true);
    assert.equal(request.applicationSuccess, null);
    assert.equal(request.preflight?.status, 204);
    assert.equal(request.preflight?.requestedMethod, 'PUT');
    assert.ok(request.preflight.requestedHeaders.includes('x-amz-meta-token'));
    assert.equal(request.headers['x-amz-meta-token'], '');
    assert.equal(request.responseHeaderAccess, null);
    const serialized = JSON.stringify(evidence);
    for (const value of ['PRIVATE_SIGNED_URL_VALUE', 'PRIVATE_HEADER_VALUE', 'SYNTHETIC_FILE_BODY'])
      assert.equal(serialized.includes(value), false);
    assert.deepEqual(await collector.finish(), evidence, 'finalization is idempotent');
  });
});

test('records a failed CORS preflight without replaying or sending the blocked PUT', async () => {
  await withCapture(async (page, collector) => {
    const before = puts;
    const result = await upload(page, '/cors');
    assert.equal(result.failed, true);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(puts, before);
    assert.equal(evidence.requests[0].browserCompleted, false);
    assert.equal(evidence.requests[0].browserCorsError, true);
    assert.equal(evidence.requests[0].status, null);
    assert.equal(evidence.requests[0].preflight?.status, 403);
  });
});

test('retains only allowlisted provider codes from bounded readable errors', async () => {
  await withCapture(async (page, collector) => {
    const result = await upload(page, '/expired-readable');
    assert.equal(result.status, 403);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.requests[0].providerCode, 'ExpiredRequest');
    assert.equal(evidence.requests[0].browserCompleted, true);
    assert.equal(JSON.stringify(evidence).includes('PRIVATE_PROVIDER_MESSAGE'), false);
  });
});

test('opaque expired response remains uncertain when Chromium cannot provide its body', async () => {
  await withCapture(async (page, collector) => {
    const result = await upload(page, '/expired');
    assert.equal(result.failed, true);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.requests[0].status, 403);
    assert.equal(evidence.requests[0].browserCorsError, true);
    assert.equal(evidence.requests[0].browserCompleted, false);
    assert.ok([null, 'ExpiredRequest'].includes(evidence.requests[0].providerCode));
    if (evidence.requests[0].providerCode === null)
      assert.ok(evidence.limitations.some((value) => value.includes('unavailable')));
    assert.equal(JSON.stringify(evidence).includes('PRIVATE_PROVIDER_MESSAGE'), false);
  });
});

test('does not retrieve error bodies with an unknown length', async () => {
  await withCapture(async (page, collector) => {
    await upload(page, '/unbounded');
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.requests[0].providerCode, null);
    assert.ok(evidence.limitations.some((value) => value.includes('safely bounded')));
  });
});

test('application assertions require a named completed upload and cannot be retroactively changed', async () => {
  await withCapture(async (page, collector) => {
    assert.throws(() => collector.markApplicationSuccess('upload-1', 'success', true), /completed/);
    const running = upload(page, '/delayed');
    await waitFor(() => collector.requests().length === 1);
    assert.throws(() => collector.markApplicationSuccess('upload-1', 'success', true), /completed/);
    assert.equal((await running).status, 200);
    await waitFor(() => collector.requests()[0]?.completed);
    collector.markApplicationSuccess('upload-1', 'uploaded_file_visible', true);
    assert.throws(
      () => collector.markApplicationSuccess('upload-1', 'different_assertion', true),
      /already/,
    );
    const evidence = await collector.finish();
    assert.equal(evidence.requests[0].applicationSuccess, true);
    assert.equal(evidence.requests[0].applicationAssertion, 'uploaded_file_visible');
    assert.throws(() => collector.markApplicationSuccess('upload-1', 'late', true), /finalized/);
  });
});

test('header-access assertions record actual JavaScript results separately from network headers', async () => {
  await withCapture(async (page, collector) => {
    const result = await upload(page, '/ok');
    await waitFor(() => collector.requests()[0]?.completed);
    collector.markResponseHeaderAccess('upload-1', { ETag: result.etag !== null });
    assert.throws(() => collector.markResponseHeaderAccess('upload-1', { etag: true }), /already/);
    const evidence = await collector.finish();
    assert.deepEqual({ ...evidence.requests[0].responseHeaderAccess }, { etag: false });
  });
});

test('an app that leaves its response body unread is not falsely reported as a browser failure', async () => {
  await withCapture(async (page, collector) => {
    const status = await page.evaluate(
      async (url) => (await fetch(url, { method: 'PUT', body: 'synthetic' })).status,
      `${storageUrl}/ok`,
    );
    assert.equal(status, 200);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.notEqual(evidence.requests[0].browserCompleted, false);
    assert.equal(evidence.requests[0].browserCorsError, false);
  });
});

test('captures a small FormData wrapper without retaining its file contents', async () => {
  await withCapture(async (page, collector) => {
    assert.equal((await upload(page, '/ok', true)).status, 200);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.requests[0].bodyKind, 'form-data');
    assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_FILE_BODY'), false);
  });
});

test('request caps and aborts produce bounded evidence and detach observation', async () => {
  const abort = new AbortController();
  await withCapture(
    async (page, collector) => {
      await upload(page, '/ok');
      await upload(page, '/ok');
      abort.abort();
      const evidence = await collector.finish();
      assert.equal(evidence.requests.length, 1);
      assert.equal(evidence.truncated, true);
      assert.ok(evidence.limitations.some((value) => value.includes('abort')));
      await upload(page, '/ok');
      assert.equal((await collector.finish()).requests.length, 1);
    },
    { maxRequests: 1, signal: abort.signal },
  );
});

test('startCapture opens an isolated real application page and closes cleanly', async () => {
  const capture = await startCapture({ url: appUrl, headless: true, contract });
  try {
    assert.equal(new URL(capture.page.url()).origin, appUrl);
    await upload(capture.page, '/ok');
    await waitFor(() => capture.requests()[0]?.completed);
    const evidence = await capture.finish();
    assert.equal(evidence.requests[0].origin, appUrl);
  } finally {
    await capture.close();
    await capture.close();
  }
  assert.equal(capture.page.isClosed(), true);
});

async function flowReport({
  type = 'application/octet-stream',
  form = false,
  assertion = true,
  uploadContract,
} = {}) {
  const selected = uploadContract ?? { ...contract, contentType: 'application/octet-stream' };
  return withCapture(
    async (page, collector) => {
      const observedSuccess = await page.evaluate(
        async ({ type, form }) => {
          const { url } = await (await fetch('/sign')).json();
          const body = form ? new FormData() : 'SYNTHETIC_FILE';
          if (form) body.append('file', 'SYNTHETIC_FILE');
          const response = await fetch(url, {
            method: 'PUT',
            body,
            headers: form ? {} : { 'Content-Type': type },
          });
          await response.arrayBuffer();
          document.body.dataset.uploadCompleted = String(response.ok);
          return response.ok && document.body.dataset.uploadCompleted === 'true';
        },
        { type, form },
      );
      await waitFor(() => collector.requests()[0]?.completed);
      if (assertion)
        collector.markApplicationSuccess('upload-1', 'upload_completed', observedSuccess);
      return createReport(await collector.finish(), selected);
    },
    { contract: selected },
  );
}

test('real browser reports verify a repaired Content-Type contract and reject incomparable proof', async () => {
  const before = await flowReport({ type: 'text/plain' });
  const after = await flowReport();
  assert.equal(
    before.findings.find((finding) => finding.ruleId === 'contract-content-type').status,
    'fail',
  );
  assert.equal(
    after.findings.find((finding) => finding.ruleId === 'contract-content-type').status,
    'pass',
  );
  assert.equal(compareReports(before, after).status, 'verified');
  assert.notEqual(compareReports(before, shareReport(after)).status, 'verified');
  const noAssertion = await flowReport({ assertion: false });
  assert.notEqual(compareReports(before, noAssertion).status, 'verified');
  const differentBucket = structuredClone(after);
  differentBucket.profiles[0].destination = 'another-bucket';
  assert.notEqual(compareReports(before, differentBucket).status, 'verified');
  const changedOrigin = structuredClone(after);
  changedOrigin.profiles[0].origin = 'https://other.example';
  assert.notEqual(compareReports(before, changedOrigin).status, 'verified');
  const repackagedOldCapture = structuredClone(after);
  repackagedOldCapture.profiles[0].requestStartedAt = before.profiles[0].requestStartedAt;
  repackagedOldCapture.capturedAt = new Date(Date.parse(after.capturedAt) + 60_000).toISOString();
  assert.notEqual(compareReports(before, repackagedOldCapture).status, 'verified');
});

test('real browser FormData-to-raw repair can resolve the body-contract finding', async () => {
  const uploadContract = { ...contract };
  const before = await flowReport({ form: true, uploadContract });
  const after = await flowReport({ uploadContract });
  assert.equal(
    before.findings.find((finding) => finding.ruleId === 'contract-body').status,
    'fail',
  );
  assert.equal(after.findings.find((finding) => finding.ruleId === 'contract-body').status, 'pass');
  assert.equal(compareReports(before, after).status, 'verified');
});

test('a mistaken GET using a signed upload URL is retained as an unsupported method', async () => {
  await withCapture(async (page, collector) => {
    await page.evaluate(async (url) => {
      try {
        await fetch(url);
      } catch {
        /* CORS is intentionally absent on 405. */
      }
    }, `${storageUrl}/fixture-bucket/ok?X-Amz-Signature=synthetic`);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(evidence.requests.length, 1);
    assert.equal(evidence.requests[0].method, 'GET');
    const report = createReport(evidence, contract);
    assert.equal(
      report.findings.find((finding) => finding.ruleId === 'upload-scope').status,
      'unsupported',
    );
    assert.equal(
      report.findings.find((finding) => finding.ruleId === 'contract-method').status,
      'fail',
    );
  });
});

test('a service-worker synthetic success does not establish storage acceptance', async () => {
  await withCapture(async (page, collector) => {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
      }
    });
    const previousPuts = puts;
    assert.equal((await upload(page, '/ok')).status, 200);
    await waitFor(() => collector.requests()[0]?.completed);
    const evidence = await collector.finish();
    assert.equal(
      puts,
      previousPuts,
      'the service worker supplied the response without a storage request',
    );
    assert.equal(evidence.requests[0].status, null);
    assert.equal(createReport(evidence, contract).uploads[0].storageAccepted, null);
    assert.ok(
      evidence.limitations.some((limitation) => limitation.includes('service worker supplied')),
    );
  });
});

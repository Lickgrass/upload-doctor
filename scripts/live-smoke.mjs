#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// This development-only test is intentionally separate from the offline diagnostic package.
// Check the opt-in and explicit credentials before importing provider SDKs or opening a socket.
function configuration() {
  const env = process.env;
  if (env.UPLOAD_DOCTOR_LIVE !== '1') return null;
  // Debug transports can print request URLs before this script can redact them.
  if (
    [env.DEBUG, env.NODE_DEBUG, env.PWDEBUG].some(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return null;
  const provider = env.UPLOAD_DOCTOR_LIVE_PROVIDER;
  const bucket = env.UPLOAD_DOCTOR_LIVE_BUCKET;
  const accessKeyId = env.UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID;
  const secretAccessKey = env.UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY;
  const sessionToken = env.UPLOAD_DOCTOR_LIVE_SESSION_TOKEN;
  const region =
    provider === 'r2' ? (env.UPLOAD_DOCTOR_LIVE_REGION ?? 'auto') : env.UPLOAD_DOCTOR_LIVE_REGION;
  const portText = env.UPLOAD_DOCTOR_LIVE_PORT ?? '43189';
  const endpointText = env.UPLOAD_DOCTOR_LIVE_ENDPOINT;
  const safeCredential = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\u0000-\u0020\u007f]/.test(value);
  if (
    !['s3', 'r2'].includes(provider) ||
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !safeCredential(accessKeyId) ||
    !safeCredential(secretAccessKey) ||
    (sessionToken !== undefined && !safeCredential(sessionToken)) ||
    (provider === 's3' &&
      (typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))) ||
    (provider === 'r2' && region !== 'auto') ||
    !/^\d{1,5}$/.test(portText) ||
    Number(portText) < 1024 ||
    Number(portText) > 65535
  )
    return null;
  let endpoint;
  if (endpointText !== undefined) {
    try {
      endpoint = new URL(endpointText);
    } catch {
      return null;
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      return null;
    const allowed =
      provider === 'r2'
        ? /^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
        : /^s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/.test(endpoint.hostname);
    if (!allowed) return null;
  }
  if (provider === 'r2' && endpoint === undefined) return null;
  return {
    provider,
    bucket,
    region,
    port: Number(portText),
    endpoint: endpoint?.origin,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
    },
  };
}

const config = configuration();
if (config === null) {
  process.stderr.write(
    'CONFIGURATION ERROR: Live test did not run. Set UPLOAD_DOCTOR_LIVE=1 and the required task-scoped variables in docs/live-testing.md.\n',
  );
  process.exitCode = 2;
} else {
  await run(config);
}

async function run(config) {
  let stage = 'loading development dependencies';
  let browser;
  let app;
  let client;
  let sdk;
  let succeeded = false;
  let cleanupFailed = false;
  let versionedObject = false;
  let interrupted = false;
  const runId = randomUUID();
  const prefix = `upload-doctor/${runId}/`;
  const attemptedKeys = new Set();
  const knownVersions = new Map();
  const abort = new AbortController();
  const payload = `Upload Doctor disposable integration fixture ${runId}\n`;
  const expectedHash = createHash('sha256').update(payload).digest('hex');
  const origin = `http://127.0.0.1:${config.port}`;
  const contentType = 'text/plain';
  const onSignal = () => {
    interrupted = true;
    abort.abort();
    if (browser) void browser.close().catch(() => undefined);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const [
      { chromium },
      sdkModule,
      { getSignedUrl },
      { attachCapture },
      { createReport, compareReports },
    ] = await Promise.all([
      import('playwright'),
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
      import('../dist/browser.js'),
      import('../dist/report.js'),
    ]);
    sdk = sdkModule;
    client = new sdk.S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Never resolve credentials or endpoint overrides from the default AWS provider chain.
      credentials: config.credentials,
      ignoreConfiguredEndpointUrls: true,
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: 20_000,
        socketTimeout: 20_000,
        throwOnRequestTimeout: true,
      },
      // This case isolates Content-Type signing. Stored bytes are independently checked below.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    stage = 'starting the local application';
    app = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const site = request.headers['sec-fetch-site'];
      if (
        request.headers.host !== `127.0.0.1:${config.port}` ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (site !== undefined && !['none', 'same-origin'].includes(site))
      ) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('Forbidden');
        return;
      }
      if (request.method !== 'GET' || request.url !== '/') {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Upload Doctor live fixture</title><p>Disposable provider integration test.</p>',
      );
    });
    await new Promise((resolve, reject) => {
      app.once('error', reject);
      app.listen(config.port, '127.0.0.1', resolve);
    });
    stage = 'starting Chromium';
    browser = await chromium.launch({ headless: true });

    async function signedPut(key) {
      if (interrupted) throw new Error('Interrupted');
      const url = await getSignedUrl(
        client,
        new sdk.PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ContentType: contentType,
        }),
        { expiresIn: 120, signableHeaders: new Set(['content-type']) },
      );
      const parsed = new URL(url);
      // If an SDK changes its defaults, do not mistake an unsigned header for a negative test.
      if (
        parsed.protocol !== 'https:' ||
        parsed.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
        !parsed.searchParams.has('X-Amz-Signature') ||
        !parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';').includes('content-type')
      ) {
        throw new Error('Expected signed header was not produced');
      }
      return url;
    }

    const negativeKey = `${prefix}mismatched-content-type.txt`;
    const positiveKey = `${prefix}matching-content-type.txt`;
    stage = 'signing the negative request';
    const negativeUrl = await signedPut(negativeKey);
    const contract = {
      version: 1,
      id: 'provider-live-content-type',
      provider: config.provider,
      storageHosts: [new URL(negativeUrl).hostname],
      method: 'PUT',
      body: 'raw',
      contentType,
      requiredResponseHeaders: ['ETag'],
      pathStyle: true,
    };

    async function captureUpload(url, key, actualContentType) {
      const context = await browser.newContext({ acceptDownloads: false });
      const page = await context.newPage();
      let collector;
      try {
        collector = await attachCapture(page, { contract, timeoutMs: 45_000, maxRequests: 3 });
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        attemptedKeys.add(key);
        const outcome = await page.evaluate(
          async ({ url, payload, actualContentType }) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15_000);
            try {
              const response = await fetch(url, {
                method: 'PUT',
                body: payload,
                headers: { 'Content-Type': actualContentType },
                credentials: 'omit',
                redirect: 'error',
                signal: controller.signal,
              });
              const etagReadable = response.headers.get('etag') !== null;
              await response.arrayBuffer();
              return { accepted: response.ok, etagReadable };
            } catch {
              return { accepted: false, etagReadable: false };
            } finally {
              clearTimeout(timeout);
            }
          },
          { url, payload, actualContentType },
        );
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const attempts = collector.requests();
          if (attempts.length === 1 && attempts[0].completed) break;
          if (attempts.length > 1 || interrupted) throw new Error('Unexpected attempt count');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const attempts = collector.requests();
        if (attempts.length !== 1 || !attempts[0].completed)
          throw new Error('Incomplete upload capture');
        const requestId = attempts[0].id;
        if (outcome.accepted)
          collector.markResponseHeaderAccess(requestId, { ETag: outcome.etagReadable });
        collector.markApplicationSuccess(
          requestId,
          'accepted-with-readable-etag',
          outcome.accepted && outcome.etagReadable,
        );
        const evidence = await collector.finish();
        if (evidence.truncated || evidence.requests.length !== 1)
          throw new Error('Incomplete upload capture');
        return { outcome, evidence, report: createReport(evidence, contract, requestId) };
      } finally {
        await collector?.finish().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    }

    stage = 'checking the rejected Content-Type request';
    const negative = await captureUpload(negativeUrl, negativeKey, 'application/octet-stream');
    if (
      negative.outcome.accepted ||
      negative.evidence.requests[0].status !== 403 ||
      !negative.report.findings.some(
        (item) =>
          item.ruleId === 'contract-content-type' &&
          item.status === 'fail' &&
          item.confidence === 'confirmed',
      )
    ) {
      throw new Error('Negative signature test was not established');
    }

    stage = 'signing the corrected request';
    const positiveUrl = await signedPut(positiveKey);
    if (new URL(positiveUrl).hostname !== contract.storageHosts[0])
      throw new Error('Signer endpoint changed');
    stage = 'checking the corrected browser upload';
    const positive = await captureUpload(positiveUrl, positiveKey, contentType);
    if (
      !positive.outcome.accepted ||
      !positive.outcome.etagReadable ||
      positive.evidence.requests[0].browserCompleted !== true ||
      positive.report.findings.some((item) => item.status === 'fail')
    ) {
      throw new Error('Positive browser test failed');
    }

    stage = 'verifying stored bytes with an independently authorized read';
    const downloaded = await client.send(
      new sdk.GetObjectCommand({ Bucket: config.bucket, Key: positiveKey }),
      {
        abortSignal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
      },
    );
    if (downloaded.VersionId && downloaded.VersionId !== 'null') {
      versionedObject = true;
      knownVersions.set(positiveKey, downloaded.VersionId);
      downloaded.Body?.destroy?.();
      throw new Error('Unversioned test bucket required');
    }
    if (!downloaded.Body || typeof downloaded.Body[Symbol.asyncIterator] !== 'function')
      throw new Error('Readable object body unavailable');
    const hash = createHash('sha256');
    let received = 0;
    const bodyDeadline = setTimeout(() => downloaded.Body.destroy?.(), 20_000);
    try {
      for await (const chunk of downloaded.Body) {
        received += chunk.length;
        if (received > Buffer.byteLength(payload)) throw new Error('Unexpected object size');
        hash.update(chunk);
      }
    } finally {
      clearTimeout(bodyDeadline);
      downloaded.Body.destroy?.();
    }
    if (received !== Buffer.byteLength(payload) || hash.digest('hex') !== expectedHash)
      throw new Error('Stored bytes differed');

    stage = 'comparing the failed and corrected captures';
    if (compareReports(negative.report, positive.report).status !== 'verified')
      throw new Error('Repair verification was not established');
    succeeded = true;
  } catch {
    // Never interpolate provider exceptions, request URLs, bucket names, credentials or response bodies.
    process.stderr.write(`FAIL: Live provider integration failed during ${stage}.\n`);
    process.stderr.write(
      'Check the dedicated test bucket, scoped credentials, exact-origin CORS and local port guidance in docs/live-testing.md.\n',
    );
    if (versionedObject)
      process.stderr.write(
        'A versioned object was detected. Use an unversioned test bucket; retained versions require separate cleanup.\n',
      );
  } finally {
    if (client && sdk) {
      for (const key of attemptedKeys) {
        try {
          const deleted = await client.send(
            new sdk.DeleteObjectCommand({
              Bucket: config.bucket,
              Key: key,
              ...(knownVersions.has(key) ? { VersionId: knownVersions.get(key) } : {}),
            }),
            {
              abortSignal: AbortSignal.timeout(20_000),
            },
          );
          // If ordinary deletion created a marker in an accidental versioned bucket,
          // also attempt to remove that newly identified marker, never unrelated versions.
          if (deleted.DeleteMarker && deleted.VersionId && deleted.VersionId !== 'null') {
            versionedObject = true;
            await client.send(
              new sdk.DeleteObjectCommand({
                Bucket: config.bucket,
                Key: key,
                VersionId: deleted.VersionId,
              }),
              {
                abortSignal: AbortSignal.timeout(20_000),
              },
            );
          }
        } catch {
          cleanupFailed = true;
        }
      }
      client.destroy();
    }
    await browser?.close().catch(() => undefined);
    if (app) {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(() => resolve()));
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (cleanupFailed)
    process.stderr.write(
      'FAIL: Disposable-object cleanup was not fully confirmed. Remove this run prefix from the dedicated test bucket.\n',
    );
  if (cleanupFailed || versionedObject) process.stderr.write(`Cleanup run prefix: ${prefix}\n`);
  if (succeeded && !cleanupFailed && !versionedObject && !interrupted) {
    process.stdout.write(
      'PASS: Provider rejected the signed Content-Type mismatch; corrected browser upload, ETag access, stored-byte SHA-256, repair comparison and object cleanup passed.\n',
    );
    process.exitCode = 0;
  } else process.exitCode = 1;
}

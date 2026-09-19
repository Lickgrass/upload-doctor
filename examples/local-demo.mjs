/**
 * Local browser test double: no AWS/R2 calls, cloud credentials, or real signatures.
 * This demonstrates capture -> diagnosis -> application repair -> comparison.
 * Run after building: node examples/local-demo.mjs
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createReport, compareReports, formatReport } from '../dist/index.js';
import { attachCapture } from '../dist/browser.js';

const contract = {
  version: 1,
  id: 'local-browser-demo',
  storageHosts: ['localhost'],
  provider: 's3',
  pathStyle: true,
  method: 'PUT',
  body: 'raw',
  contentType: 'application/octet-stream',
};
let appOrigin;
let storageOrigin;

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function freshSyntheticUrl() {
  const url = new URL(`${storageOrigin}/demo-bucket/disposable-${randomUUID()}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', 'SYNTHETIC_DEMO_CREDENTIAL');
  url.searchParams.set('X-Amz-Signature', `SYNTHETIC_${randomUUID()}`);
  url.searchParams.set(
    'X-Amz-Date',
    new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, ''),
  );
  url.searchParams.set('X-Amz-Expires', '600');
  url.searchParams.set('X-Amz-SignedHeaders', 'host;content-type');
  return url.href;
}

const application = await listen((request, response) => {
  if (request.url === '/sign') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ url: freshSyntheticUrl() }));
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html lang="en"><title>Upload Doctor local fixture</title>
    <h1>Local upload test double</h1>
    <p>This fixture does not contact AWS or R2 and does not validate real signatures.</p>
    <p id="status">Ready</p>
    <script>
      window.demoUpload = async function (contentType) {
        document.getElementById('status').textContent = 'Uploading';
        const signed = await (await fetch('/sign')).json();
        const response = await fetch(signed.url, {
          method: 'PUT', body: 'Synthetic disposable file',
          headers: { 'Content-Type': contentType }
        });
        await response.arrayBuffer();
        document.getElementById('status').textContent = response.ok ? 'Upload complete' : 'Upload rejected';
        return response.status;
      };
    </script></html>`);
});
appOrigin = `http://127.0.0.1:${application.address().port}`;

const storage = await listen(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', appOrigin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'PUT',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '0',
    });
    response.end();
    return;
  }
  if (request.method !== 'PUT') {
    response.writeHead(405);
    response.end();
    return;
  }
  for await (const _chunk of request) {
    /* Only this demo's synthetic bytes are consumed. */
  }
  // A deterministic simulation, not an implementation of AWS signature verification.
  if (request.headers['content-type'] !== contract.contentType) {
    const body = '<Error><Code>SignatureDoesNotMatch</Code></Error>';
    response.writeHead(403, {
      'Content-Type': 'application/xml',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  } else {
    response.writeHead(200, { 'Content-Length': '0', ETag: 'synthetic-demo-etag' });
    response.end();
  }
});
storageOrigin = `http://localhost:${storage.address().port}`;

let browser;
try {
  console.log('Upload Doctor local browser demo');
  console.log(
    'Synthetic test double: no AWS/R2 requests, real signatures, cloud credentials, or report files.\n',
  );
  browser = await chromium.launch({ headless: true });

  async function run(contentType) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const collector = await attachCapture(page, { contract });
    try {
      await page.goto(appOrigin);
      await page.evaluate((type) => window.demoUpload(type), contentType);
      const applicationPassed = (await page.locator('#status').textContent()) === 'Upload complete';
      for (let index = 0; !collector.requests()[0]?.completed && index < 100; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      collector.markApplicationSuccess('upload-1', 'completed_upload_indicator', applicationPassed);
      return createReport(await collector.finish(), contract);
    } finally {
      await collector.finish();
      await context.close();
    }
  }

  const before = await run('text/plain');
  console.log('Before: the application sends the wrong Content-Type.');
  console.log(formatReport(before));
  const after = await run(contract.contentType);
  console.log(
    'After: the same application flow uses the declared Content-Type and obtains a fresh URL.',
  );
  const comparison = compareReports(before, after);
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.status !== 'verified')
    throw new Error('The synthetic repair did not meet the verification checks.');
  console.log(
    '\nVerified only for this local fixture. No live-provider compatibility or file-integrity claim is made.',
  );
} finally {
  await browser?.close();
  await Promise.all(
    [application, storage].map((server) => new Promise((resolve) => server.close(resolve))),
  );
}

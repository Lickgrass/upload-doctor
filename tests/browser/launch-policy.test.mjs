import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { attachCapture, startCapture } from '../../dist/browser.js';

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalCounts = () => signals.map((signal) => process.listenerCount(signal));

async function fixture(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('owned Chromium is sandboxed by default; only an explicit opt-out disables it', async () => {
  const app = await fixture((_request, response) =>
    response.end('<!doctype html><title>Test</title>'),
  );
  const originalLaunch = chromium.launch;
  const requested = [];
  chromium.launch = function (options) {
    requested.push(options);
    // This test-only flag permits CDP to return the actual running process arguments.
    return originalLaunch.call(this, {
      ...options,
      args: [...(options.args ?? []), '--enable-automation'],
    });
  };
  try {
    for (const insecureNoSandbox of [undefined, false, true]) {
      const beforeSignals = signalCounts();
      const session = await startCapture({ url: app.url, headless: true, insecureNoSandbox });
      try {
        const cdp = await session.page.context().newCDPSession(session.page);
        const actual = await cdp.send('Browser.getBrowserCommandLine');
        await cdp.detach();
        assert.equal(actual.arguments.includes('--no-sandbox'), insecureNoSandbox === true);
        assert.deepEqual(signalCounts(), beforeSignals, 'Playwright must not own process signals');
        assert.equal(requested.at(-1).chromiumSandbox, insecureNoSandbox !== true);
        for (const signal of signals) assert.equal(requested.at(-1)[`handle${signal}`], false);
        assert.equal(requested.at(-1).timeout, 30_000);
      } finally {
        await Promise.all([session.close(), session.close()]);
      }
      assert.deepEqual(signalCounts(), beforeSignals);
    }
  } finally {
    chromium.launch = originalLaunch;
    await app.close();
  }
});

test('a failed sandboxed launch reports a fixed error and never retries without the sandbox', async () => {
  const originalLaunch = chromium.launch;
  const attempted = [];
  chromium.launch = async (options) => {
    attempted.push(options);
    throw new Error('CANARY_PRIVATE_BROWSER_LOG');
  };
  try {
    await assert.rejects(
      startCapture({ url: 'https://example.invalid/CANARY_TARGET', headless: true }),
      (error) => {
        assert.equal(error.name, 'InputError');
        assert.match(error.message, /sandbox enabled/);
        assert.match(error.message, /--insecure-no-sandbox/);
        assert.doesNotMatch(error.message, /CANARY/);
        return true;
      },
    );
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0].chromiumSandbox, true);
    await assert.rejects(
      startCapture({ url: 'https://example.invalid', insecureNoSandbox: true }),
      (error) => error.name === 'InputError' && !error.message.includes('CANARY'),
    );
    assert.equal(attempted.length, 2);
    assert.equal(attempted[1].chromiumSandbox, false);
  } finally {
    chromium.launch = originalLaunch;
  }
});

test('pre-aborted startup and non-boolean sandbox opt-outs cannot launch Chromium', async () => {
  const originalLaunch = chromium.launch;
  let launches = 0;
  chromium.launch = async () => {
    launches++;
    throw new Error('Unexpected launch');
  };
  try {
    await assert.rejects(
      startCapture({ url: 'https://example.invalid', signal: AbortSignal.abort() }),
      { name: 'InputError', message: 'Capture was interrupted before observation started.' },
    );
    for (const insecureNoSandbox of ['false', 'true', 1, {}, null]) {
      await assert.rejects(startCapture({ url: 'https://example.invalid', insecureNoSandbox }), {
        name: 'InputError',
        message: 'insecureNoSandbox must be an explicit boolean.',
      });
    }
    assert.equal(launches, 0);
  } finally {
    chromium.launch = originalLaunch;
  }
});

test('aborting while launch is pending closes the eventual owned browser before navigation', async () => {
  const originalLaunch = chromium.launch;
  const entered = Promise.withResolvers();
  const launch = Promise.withResolvers();
  const abort = new AbortController();
  let closes = 0;
  let contexts = 0;
  chromium.launch = async () => {
    entered.resolve();
    return launch.promise;
  };
  try {
    const starting = startCapture({ url: 'https://example.invalid', signal: abort.signal });
    const rejected = assert.rejects(starting, {
      name: 'InputError',
      message: 'Capture was interrupted before observation started.',
    });
    await entered.promise;
    abort.abort();
    launch.resolve({
      async close() {
        closes++;
      },
      async newContext() {
        contexts++;
        throw new Error('Unexpected context');
      },
    });
    await rejected;
    assert.equal(closes, 1);
    assert.equal(contexts, 0);
  } finally {
    chromium.launch = originalLaunch;
  }
});

test('startup abort closes real Chromium and interrupts a hanging page navigation', async () => {
  const arrived = Promise.withResolvers();
  const app = await fixture(() => arrived.resolve());
  const abort = new AbortController();
  const originalLaunch = chromium.launch;
  let browser;
  chromium.launch = async function (options) {
    browser = await originalLaunch.call(this, options);
    return browser;
  };
  try {
    const starting = startCapture({
      url: `${app.url}/CANARY_PRIVATE_URL`,
      headless: true,
      signal: abort.signal,
    });
    const rejected = assert.rejects(starting, {
      name: 'InputError',
      message: 'Capture was interrupted before observation started.',
    });
    await arrived.promise;
    const startedAbort = Date.now();
    abort.abort();
    await rejected;
    assert.equal(browser.isConnected(), false);
    assert.ok(Date.now() - startedAbort < 5_000, 'abort must interrupt the 30-second navigation');
  } finally {
    chromium.launch = originalLaunch;
    await browser?.close();
    await app.close();
  }
});

test('after startup the owner can finalize aborted capture before closing Chromium', async () => {
  const app = await fixture((_request, response) =>
    response.end('<!doctype html><title>Test</title>'),
  );
  const abort = new AbortController();
  let session;
  try {
    session = await startCapture({ url: app.url, headless: true, signal: abort.signal });
    const browser = session.page.context().browser();
    abort.abort();
    const evidence = await session.finish();
    assert.ok(evidence.limitations.some((value) => value.includes('abort signal')));
    assert.equal(
      browser.isConnected(),
      true,
      'an abort must not preempt owner-driven finalization',
    );
    await session.close();
    assert.equal(browser.isConnected(), false);
  } finally {
    await session?.close();
    await app.close();
  }
});

test('a stalled CDP detach has a referenced deadline and cannot strand finalization', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    const context = await browser.newContext();
    const newCDP = context.newCDPSession;
    context.newCDPSession = async function (...args) {
      const session = await newCDP.apply(this, args);
      session.detach = () => new Promise(() => undefined);
      return session;
    };
    const page = await context.newPage();
    const collector = await attachCapture(page);
    const started = Date.now();
    const evidence = await collector.finish();
    assert.ok(Date.now() - started < 4_000);
    assert.ok(evidence.limitations.some((value) => value.includes('detachment did not finish')));

    const nextPage = await context.newPage();
    const nextCollector = await attachCapture(nextPage);
    const finishing = nextCollector.finish();
    const closing = Date.now();
    await nextPage.close();
    const closedEvidence = await finishing;
    assert.ok(Date.now() - closing < 1_000, 'a closed page does not need a detach deadline');
    assert.ok(
      !closedEvidence.limitations.some((value) => value.includes('detachment did not finish')),
    );
  } finally {
    await browser.close();
  }
});

test('live harness uses sandbox and caller-owned signals; unsafe opt-out must be explicit', () => {
  const playwrightUrl = import.meta.resolve('playwright');
  const preload = `
    import http from 'node:http';
    import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    import {chromium} from ${JSON.stringify(playwrightUrl)};
    let networkAttempts = 0, applications = 0;
    const launches = [];
    net.Socket.prototype.connect = () => {networkAttempts++; throw new Error('network tripwire');};
    http.createServer = () => {
      applications++;
      return {once(){},listen(_port,_host,ready){ready();},closeAllConnections(){},close(done){done();}};
    };
    syncBuiltinESMExports();
    chromium.launch = async options => {launches.push(options); throw new Error('CANARY_LAUNCH_ERROR');};
    process.on('exit',()=>process.stdout.write(JSON.stringify({networkAttempts,applications,launches})));
  `;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('UPLOAD_DOCTOR_LIVE') && !['DEBUG', 'NODE_DEBUG', 'PWDEBUG'].includes(key),
    ),
  );
  Object.assign(env, {
    UPLOAD_DOCTOR_LIVE: '1',
    UPLOAD_DOCTOR_LIVE_PROVIDER: 's3',
    UPLOAD_DOCTOR_LIVE_BUCKET: 'synthetic-bucket',
    UPLOAD_DOCTOR_LIVE_REGION: 'us-east-1',
    UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID: 'CANARY_ACCESS',
    UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY: 'CANARY_SECRET',
  });
  for (const value of [undefined, '0', '1', 'true', 'false', '']) {
    const result = spawnSync(
      process.execPath,
      [
        `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
        fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url)),
      ],
      {
        env: {
          ...env,
          ...(value === undefined ? {} : { UPLOAD_DOCTOR_LIVE_INSECURE_NO_SANDBOX: value }),
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    assert.ifError(result.error);
    assert.doesNotMatch(result.stderr + result.stdout, /CANARY|tripwire/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.networkAttempts, 0);
    if (value === undefined || value === '0' || value === '1') {
      assert.equal(result.status, 1);
      assert.equal(output.applications, 1);
      assert.equal(output.launches.length, 1);
      assert.equal(output.launches[0].chromiumSandbox, value !== '1');
      for (const signal of signals) assert.equal(output.launches[0][`handle${signal}`], false);
      assert.equal(output.launches[0].timeout, 30_000);
      assert.equal(
        result.stderr.includes('WARNING: Chromium sandbox explicitly disabled'),
        value === '1',
      );
    } else {
      assert.equal(result.status, 2);
      assert.equal(output.applications, 0);
      assert.equal(output.launches.length, 0);
    }
  }
});

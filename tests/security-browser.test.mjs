import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const browserModule = new URL('../dist/browser.js', import.meta.url).href;
const diagnostics = { DEBUG: 'pw:protocol', NODE_DEBUG: 'http', PWDEBUG: '1' };

function child(source, environment = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(diagnostics)) delete env[name];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...env, ...environment },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'rejected capture must not emit diagnostic logs');
  assert.ok(!result.stdout.includes('SECRET_CANARY'));
  return JSON.parse(result.stdout);
}

const exercise = `
  let contexts = 0;
  const page = { context() { contexts++; throw new Error('CDP should never be reached'); } };
  const failures = [];
  for (const run of [
    () => api.attachCapture(page),
    () => api.startCapture({url:'https://example.invalid/SECRET_CANARY?token=SECRET_CANARY',headless:true})
  ]) {
    try { await run(); throw new Error('capture unexpectedly accepted'); }
    catch (error) {
      if (!error.message.includes('Start a fresh process')) throw error;
      if (error.message.includes('SECRET_CANARY')) throw new Error('input leaked');
      failures.push(error.message);
    }
  }
  console.log(JSON.stringify({contexts,failures:failures.length}));
`;

test('browser entry points reject diagnostic logging before CDP or browser launch', () => {
  for (const [name, value] of Object.entries(diagnostics)) {
    assert.deepEqual(
      child(`const api = await import(${JSON.stringify(browserModule)});${exercise}`, {
        [name]: value,
      }),
      { contexts: 0, failures: 2 },
    );
  }
});

test('deleting diagnostic variables after module import does not clear the logging guard', () => {
  for (const [name, value] of Object.entries(diagnostics)) {
    assert.deepEqual(
      child(
        `const api = await import(${JSON.stringify(browserModule)});delete process.env[${JSON.stringify(name)}];${exercise}`,
        { [name]: value },
      ),
      { contexts: 0, failures: 2 },
    );
  }
});

test('diagnostics enabled after import are rejected and remain rejected after removal', () => {
  for (const [name, value] of Object.entries(diagnostics)) {
    assert.deepEqual(
      child(`
        const api = await import(${JSON.stringify(browserModule)});
        process.env[${JSON.stringify(name)}] = ${JSON.stringify(value)};
        await api.attachCapture({}).then(
          () => { throw new Error('capture unexpectedly accepted'); },
          error => { if (!error.message.includes('Start a fresh process')) throw error; }
        );
        delete process.env[${JSON.stringify(name)}];
        ${exercise}
      `),
      { contexts: 0, failures: 2 },
    );
  }
});

test('clean logging environment passes the guard and reaches ordinary page validation', () => {
  assert.deepEqual(
    child(`
      const api = await import(${JSON.stringify(browserModule)});
      let contexts = 0;
      try {
        await api.attachCapture({context(){contexts++;throw new Error('SECRET_CANARY');}});
        throw new Error('invalid page unexpectedly accepted');
      } catch(error) {
        if (!error.message.includes('requires a Chromium page')) throw error;
        if (error.message.includes('SECRET_CANARY')) throw new Error('input leaked');
      }
      console.log(JSON.stringify({contexts}));
    `),
    { contexts: 1 },
  );
});

test('CLI rejects protocol logging with a useful safe error before networking or Chromium', () => {
  const preload = `
    import net from 'node:net';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    let networkAttempts = 0, browserLaunches = 0;
    net.Socket.prototype.connect = () => {networkAttempts++;throw new Error('network tripwire');};
    childProcess.spawn = () => {browserLaunches++;throw new Error('browser tripwire');};
    syncBuiltinESMExports();
    process.on('exit',()=>process.stdout.write(JSON.stringify({networkAttempts,browserLaunches})));
  `;
  const env = { ...process.env, DEBUG: 'pw:protocol' };
  delete env.NODE_DEBUG;
  delete env.PWDEBUG;
  const result = spawnSync(
    process.execPath,
    [
      `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      'capture',
      'http://127.0.0.1:9/SECRET_CANARY?token=SECRET_CANARY',
      '--duration',
      '1',
      '--headless',
    ],
    { env, encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DEBUG, NODE_DEBUG and PWDEBUG/);
  assert.match(result.stderr, /Start a fresh process/);
  assert.doesNotMatch(result.stderr + result.stdout, /SECRET_CANARY|pw:protocol|tripwire/);
  assert.deepEqual(JSON.parse(result.stdout), { networkAttempts: 0, browserLaunches: 0 });
});

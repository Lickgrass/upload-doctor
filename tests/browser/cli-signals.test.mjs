import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(
    `CLI ${signal} saves captured evidence and exits through its report path`,
    {
      skip: process.platform === 'win32' ? 'POSIX signal delivery test' : false,
      timeout: 20000,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'upload-doctor-signals-'));
      const output = join(directory, 'report.json');
      let uploaded;
      const ready = new Promise((resolve) => {
        uploaded = resolve;
      });
      const server = createServer(async (request, response) => {
        if (request.method === 'PUT') {
          for await (const _chunk of request) {
            /* Consume only synthetic fixture bytes. */
          }
          response.writeHead(200, { 'Content-Length': '0' });
          response.end();
        } else if (request.url === '/ready') {
          response.end('ready');
          uploaded();
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><title>Signal fixture</title><script>
          (async () => {
            const r = await fetch('/fixture-bucket/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=SYNTHETIC&X-Amz-SignedHeaders=host', {method:'PUT',body:'synthetic'});
            await r.arrayBuffer();
            await fetch('/ready');
          })();
        </script>`);
        }
      });
      let child;
      let deadline;
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const env = { ...process.env };
        for (const name of ['DEBUG', 'NODE_DEBUG', 'PWDEBUG']) delete env[name];
        child = spawn(
          process.execPath,
          [
            cli,
            'capture',
            `http://127.0.0.1:${server.address().port}`,
            '--storage-host',
            '127.0.0.1',
            '--duration',
            '30',
            '--headless',
            '--out',
            output,
          ],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        let stdout = '';
        let markStarted;
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (stderr.includes('Capture started.')) markStarted();
        });
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        const exited = once(child, 'exit');
        deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
        await Promise.race([
          Promise.all([started, ready]),
          exited.then(([code, cause]) => {
            throw new Error(`Capture exited before ready (${code}/${cause}): ${stderr}`);
          }),
        ]);
        assert.equal(child.kill(signal), true);
        const [code, cause] = await exited;
        assert.equal(cause, null, stderr);
        // A custom host without a provider contract is deliberately unsupported.
        assert.equal(code, 3, stderr);
        const report = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(report.source, 'browser');
        assert.equal(report.coverage.uploadsObserved, 1);
        // The browser may still have a queued CDP completion event when stopped.
        // Preserve uncertainty rather than infer completion from the fixture server.
        assert.ok([true, null].includes(report.uploads[0].browserCompleted));
        assert.match(stdout, /Upload Doctor/);
        assert.doesNotMatch(stdout + stderr, /SYNTHETIC|fixture-bucket\/object/);
      } finally {
        clearTimeout(deadline);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test(
  'CLI interruption during navigation cancels startup with a fixed error',
  {
    skip: process.platform === 'win32' ? 'POSIX signal delivery test' : false,
    timeout: 20000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upload-doctor-startup-signal-'));
    const output = join(directory, 'report.json');
    let navigating;
    const navigation = new Promise((resolve) => {
      navigating = resolve;
    });
    const server = createServer(() => {
      navigating();
    });
    let child;
    let deadline;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const env = { ...process.env };
      for (const name of ['DEBUG', 'NODE_DEBUG', 'PWDEBUG']) delete env[name];
      child = spawn(
        process.execPath,
        [
          cli,
          'capture',
          `http://127.0.0.1:${server.address().port}/PRIVATE_URL_CANARY`,
          '--headless',
          '--out',
          output,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      const exited = once(child, 'exit');
      deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
      await Promise.race([
        navigation,
        exited.then(([code, cause]) => {
          throw new Error(`Startup exited before navigation (${code}/${cause}): ${stderr}`);
        }),
      ]);
      child.kill('SIGINT');
      const [code, cause] = await exited;
      assert.equal(cause, null, stderr);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /interrupted before observation started/);
      assert.doesNotMatch(stderr + stdout, /PRIVATE_URL_CANARY/);
      assert.equal(stdout, '');
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } finally {
      clearTimeout(deadline);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

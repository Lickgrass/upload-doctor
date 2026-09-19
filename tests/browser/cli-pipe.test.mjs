import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test(
  'a closed stdout pipe preserves the saved report, report exit code and browser cleanup',
  {
    timeout: 20_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upload-doctor-closed-pipe-'));
    const output = join(directory, 'report.json');
    const marker = join(directory, 'browser-close.txt');
    const server = createServer(async (request, response) => {
      if (request.method === 'PUT') {
        for await (const _chunk of request) {
          /* Consume only the synthetic fixture payload. */
        }
        response.writeHead(200, { 'Content-Length': '0' });
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Pipe fixture</title><script>
      fetch('/fixture-bucket/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=SYNTHETIC&X-Amz-SignedHeaders=host',
        {method:'PUT',body:'synthetic'}).then(response => response.arrayBuffer());
    </script>`);
    });
    // Delay real browser closure enough to observe a premature process.exit on EPIPE.
    const preload = `
    import {appendFile} from 'node:fs/promises';
    import {chromium} from ${JSON.stringify(import.meta.resolve('playwright'))};
    const originalLaunch = chromium.launch;
    chromium.launch = async function(options) {
      const browser = await originalLaunch.call(this, options);
      const originalClose = browser.close;
      browser.close = async function(...args) {
        await appendFile(${JSON.stringify(marker)}, ${JSON.stringify('started\n')});
        await new Promise(resolve => setTimeout(resolve, 200));
        await originalClose.apply(this, args);
        await appendFile(${JSON.stringify(marker)}, ${JSON.stringify('closed\n')});
      };
      return browser;
    };
  `;
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
          `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
          fileURLToPath(new URL('../../dist/cli.js', import.meta.url)),
          'capture',
          `http://127.0.0.1:${server.address().port}`,
          '--storage-host',
          '127.0.0.1',
          '--duration',
          '1',
          '--headless',
          '--out',
          output,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = once(child, 'exit');
      child.stdout.destroy();
      deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const [code, cause] = await exited;
      assert.equal(cause, null, stderr);
      assert.equal(code, 3, `closed stdout must preserve the report exit code: ${stderr}`);
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.source, 'browser');
      assert.equal(report.coverage.uploadsObserved, 1);
      assert.equal(report.uploads[0].browserCompleted, true);
      assert.equal(await readFile(marker, 'utf8'), 'started\nclosed\n');
      assert.doesNotMatch(stderr, /SYNTHETIC|fixture-bucket\/object/);
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

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { readJsonFile, writeJsonFile } from './io.js';
import {
  compareReports,
  createReport,
  formatReport,
  inspectHar,
  reportExitCode,
  shareReport,
  VERSION,
} from './report.js';
import { InputError, parseContract, safeUrl } from './validation.js';
import type { Contract, Report } from './types.js';

const HELP = `Upload Doctor ${VERSION}
Diagnose S3/R2 uploads from local evidence. No account or cloud admin keys required.

Usage:
  upload-doctor inspect FILE.har [--contract FILE] [--request upload-N]
  upload-doctor capture APP_URL [--contract FILE] [--storage-host HOST]
  upload-doctor compare BEFORE.json AFTER.json
  upload-doctor share REPORT.json

Options:
  --json              Print structured JSON instead of terminal text
  --out FILE          Write JSON to a NEW file (never overwrites; private permissions)
  --strict            Exit 3 on unknown checks, unless detected failures cause exit 1
  --contract FILE     Read a version 1 upload contract
  --request upload-N  Select one upload during offline inspection
  --storage-host HOST Select capture host; repeatable; cannot combine with --contract
  --duration SECONDS  Capture duration (1–600; default 30); Ctrl-C finishes early
  --headless          Run Chromium without a visible window
  --help              Show this help
  --version           Print version

Capture uses optional Playwright and Chromium. It observes the normal application
flow. It does not replay requests, configure buckets, or assert app success itself.
Local reports contain origin/endpoint metadata. Use share before posting reports.
HAR inspection performs no network requests. Input limit: 32 MiB.

Exit codes: 0 no detected failures / verified comparison; 1 detected failure;
2 invocation, input, I/O or browser error; 3 incomplete or inconclusive evidence.
Exit 0 from inspect/capture is NOT proof of application success.
`;

const flagNames = [
  'json',
  'out',
  'strict',
  'contract',
  'request',
  'storage-host',
  'duration',
  'headless',
  'help',
  'version',
] as const;
const allowed: Record<string, readonly string[]> = {
  inspect: ['json', 'out', 'strict', 'contract', 'request'],
  capture: ['json', 'out', 'strict', 'contract', 'storage-host', 'duration', 'headless'],
  compare: ['json', 'out'],
  share: ['json', 'out'],
};
async function print(
  value: unknown,
  json: boolean,
  output: string | undefined,
  text: string,
): Promise<void> {
  if (output) await writeJsonFile(output, value);
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

export async function main(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        out: { type: 'string' },
        strict: { type: 'boolean' },
        contract: { type: 'string' },
        request: { type: 'string' },
        'storage-host': { type: 'string', multiple: true },
        duration: { type: 'string' },
        headless: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    });
  } catch {
    throw new InputError('Invalid arguments. Run upload-doctor --help.');
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!positionals.length && !Object.keys(values).length) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, first, second] = positionals;
  if (
    !command ||
    !Object.hasOwn(allowed, command) ||
    !first ||
    positionals.length !== (command === 'compare' ? 3 : 2) ||
    flagNames.some((f) => values[f] !== undefined && !allowed[command]!.includes(f))
  )
    throw new InputError('Invalid command or options. Run upload-doctor --help.');
  if (values.out === '' || values.contract === '')
    throw new InputError('File options must not be empty.');
  if (command === 'share') {
    const result = shareReport(await readJsonFile(first));
    await print(result, true, values.out, '');
    return 0;
  }
  if (command === 'compare') {
    const result = compareReports(await readJsonFile(first), await readJsonFile(second!));
    await print(
      result,
      values.json ?? false,
      values.out,
      `${result.status.toUpperCase()}: ${result.reason}\n`,
    );
    return result.status === 'verified' ? 0 : result.status === 'not-fixed' ? 1 : 3;
  }
  let contract: Contract | undefined = values.contract
    ? parseContract(await readJsonFile(values.contract))
    : undefined;
  let report: Report;
  if (command === 'inspect') {
    if (values.request !== undefined && !/^upload-[1-9][0-9]{0,3}$/.test(values.request))
      throw new InputError('Invalid upload identifier.');
    report = inspectHar(await readJsonFile(first), {
      ...(contract ? { contract } : {}),
      ...(values.request ? { requestId: values.request } : {}),
    });
  } else {
    if (!safeUrl(first))
      throw new InputError('Capture URL must be HTTP(S), without embedded credentials.');
    if (values['storage-host']) {
      if (contract) throw new InputError('Use either --contract or --storage-host.');
      contract = parseContract({
        version: 1,
        id: 'capture-hosts',
        storageHosts: values['storage-host'],
      });
    }
    const duration = values.duration ?? '30';
    if (!/^\d{1,3}$/.test(duration) || Number(duration) < 1 || Number(duration) > 600)
      throw new InputError('Capture duration must be 1–600 seconds.');
    let browserModule;
    try {
      browserModule = await import('./browser.js');
    } catch {
      throw new InputError(
        'Browser capture requires Playwright. Install playwright and run playwright install chromium.',
      );
    }
    const session = await browserModule.startCapture({
      url: first,
      ...(contract ? { contract } : {}),
      headless: values.headless ?? false,
      timeoutMs: Math.min(Number(duration) * 1000 + 30000, 660000),
    });
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      if (!values.json)
        process.stderr.write(
          'Capture started. Perform your upload in Chromium; Ctrl-C finishes early.\n',
        );
      await delay(Number(duration) * 1000, undefined, { signal: controller.signal }).catch(
        (error) => {
          if (!controller.signal.aborted) throw error;
        },
      );
      report = createReport(await session.finish(), contract);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await session.close();
    }
  }
  await print(report, values.json ?? false, values.out, formatReport(report));
  return reportExitCode(report, values.strict ?? false);
}

// Importing the CLI for tests must not execute it. Errors never echo input or browser logs.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  process.stdout.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
    throw error;
  });
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof InputError ? error.message : 'Operation failed. Input and browser details were omitted to protect credentials.'}\n`,
      );
      process.exitCode = 2;
    });
}

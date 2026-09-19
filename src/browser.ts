import type { Browser, CDPSession, Page } from 'playwright';
import { normalizeHar, providerForHost, PROVIDER_CODES } from './normalize.js';
import { InputError } from './validation.js';
import type { CaptureEvidence, Contract } from './types.js';

const DIAGNOSTIC_ENV = ['DEBUG', 'NODE_DEBUG', 'PWDEBUG'] as const;
function diagnosticEnvironmentEnabled(): boolean {
  return DIAGNOSTIC_ENV.some((name) => Boolean(process.env[name]));
}
// Logging libraries can cache their configuration at import time. Once observed,
// removing the environment variable is not evidence that those loggers stopped.
let unsafeDiagnosticEnvironment = diagnosticEnvironmentEnabled();
function requirePrivateCaptureEnvironment(): void {
  unsafeDiagnosticEnvironment ||= diagnosticEnvironmentEnabled();
  if (unsafeDiagnosticEnvironment) {
    throw new InputError(
      'Browser capture requires DEBUG, NODE_DEBUG and PWDEBUG to be disabled. Start a fresh process with these variables unset before importing Playwright or Upload Doctor.',
    );
  }
}

const MAX_URL = 16_384;
const MAX_BODY = 16_384;
const MAX_HEADERS = 128;
const VALUE_HEADERS = new Set([
  'origin',
  'host',
  'content-type',
  'content-length',
  'content-encoding',
  'access-control-request-method',
  'access-control-request-headers',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'x-amz-bucket-region',
  'location',
]);

type Header = { name: string; value: string };
type RawHeaders = Record<string, string | number>;
type NetworkEvent =
  | 'Network.requestWillBeSent'
  | 'Network.requestWillBeSentExtraInfo'
  | 'Network.responseReceived'
  | 'Network.responseReceivedExtraInfo'
  | 'Network.loadingFinished'
  | 'Network.loadingFailed';
type Entry = {
  startedDateTime: string;
  request: { url: string; method: string; headers: Header[] };
  response: { status: number; headers: Header[]; content: { text: string } };
  _uploadDoctor: {
    headersComplete: boolean;
    responseHeadersComplete: boolean;
    bodyKind: 'raw' | 'form-data' | 'unknown';
    browserCorsError: boolean;
    browserCompleted?: boolean;
    applicationSuccess?: boolean;
    applicationAssertion?: string;
    responseHeaderAccess?: Record<string, boolean>;
  };
};
type State = {
  cdpId: string;
  id: string | null;
  entry: Entry;
  terminal: boolean;
  redirected: boolean;
  errorBodyStarted: boolean;
  responseDelivered: boolean;
  serviceWorkerResponse: boolean;
};

export interface CaptureOptions {
  contract?: Contract;
  /** Maximum upload attempts retained; defaults to 100, maximum 1,000. */
  maxRequests?: number;
  /** Detach automatically after this duration; defaults to five minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CaptureCollector {
  /** Finalizes observation and detaches. Does not wait for the app to finish uploading. */
  finish(): Promise<CaptureEvidence>;
  /** Safe IDs for correlating an assertion with a specific observed attempt. */
  requests(): ReadonlyArray<{ id: string; method: string; completed: boolean }>;
  /** Call only after an assertion associated with this attempt has actually run. */
  markApplicationSuccess(requestId: string, assertionId: string, success: boolean): void;
  /** Record results of actual response.headers access performed inside application JavaScript. */
  markResponseHeaderAccess(requestId: string, access: Record<string, boolean>): void;
}

export interface StartCaptureOptions extends CaptureOptions {
  url: string;
  headless?: boolean;
}

export interface CaptureSession extends CaptureCollector {
  page: Page;
  close(): Promise<void>;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return selected;
}

function storageHost(raw: string, contract?: Contract): boolean {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return contract ? contract.storageHosts.includes(host) : providerForHost(host) !== 'unknown';
  } catch {
    return false;
  }
}

function safeHeaders(raw: RawHeaders): { headers: Header[]; complete: boolean } {
  const headers: Header[] = [];
  let complete = true;
  for (const [rawName, rawValue] of Object.entries(raw)) {
    if (headers.length >= MAX_HEADERS) {
      complete = false;
      break;
    }
    const lowered = rawName.toLowerCase();
    // HTTP/2 pseudo-headers are transport metadata; :authority supplies Host.
    if ([':method', ':path', ':scheme', ':status'].includes(lowered)) continue;
    const name = lowered === ':authority' ? 'host' : lowered;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(name)) {
      complete = false;
      continue;
    }
    // Preserve other header names for signed-header presence checks, never values.
    let value = VALUE_HEADERS.has(name) ? String(rawValue) : '';
    if (value.length > 2_048) {
      value = '';
      complete = false;
    }
    if (name === 'location' && value) {
      try {
        const location = new URL(value);
        location.username = '';
        location.password = '';
        location.search = '';
        location.hash = '';
        value = location.href;
      } catch {
        value = '';
      }
    }
    headers.push({ name, value });
  }
  return { headers, complete };
}

function header(headers: Header[], name: string): string | undefined {
  return headers.find((candidate) => candidate.name === name)?.value;
}

function providerCode(body: string): string | null {
  if (body.length > MAX_BODY) return null;
  const match = /<Code>\s*([A-Za-z][A-Za-z0-9]{0,63})\s*<\/Code>/.exec(body);
  return match?.[1] && PROVIDER_CODES.has(match[1]) ? match[1] : null;
}

/**
 * Observe an existing Chromium page without intercepting, replaying or modifying requests.
 * Attach before the app action. No cloud credentials, raw HAR files or browser traces are written.
 * Caller-owned logging/tracing is outside this collector's control. Disable it before importing
 * Playwright and keep it disabled; this API cannot detect loggers enabled before its import.
 */
export async function attachCapture(
  page: Page,
  options: CaptureOptions = {},
): Promise<CaptureCollector> {
  requirePrivateCaptureEnvironment();
  const maxRequests = boundedInteger(options.maxRequests, 100, 1_000, 'maxRequests');
  const timeoutMs = boundedInteger(options.timeoutMs, 300_000, 3_600_000, 'timeoutMs');
  const contract = options.contract ? structuredClone(options.contract) : undefined;
  normalizeHar({ log: { entries: [] } }, contract, { trustedBrowser: true });
  if (options.signal?.aborted) throw new Error('Capture was aborted before observation started.');
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    throw new Error('Browser capture requires a Chromium page with an available DevTools session.');
  }

  const entries: Entry[] = [];
  const active = new Map<string, State>();
  const uploads: State[] = [];
  const preflightFor = new Map<string, State>();
  const pending = new Set<Promise<void>>();
  const limitations = new Set<string>([
    'Passive browser capture does not establish intended file integrity or application success without explicit assertions.',
    'Capture covers this Chromium page; separate pages, service-worker-owned traffic, cached preflights, and missing provider bodies may be incomplete.',
  ]);
  let stopped = false;
  let truncated = false;
  let finishing: Promise<CaptureEvidence> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function boundedFailure(): void {
    truncated = true;
    limitations.add(
      'A browser event exceeded capture limits or could not be interpreted; affected checks remain incomplete.',
    );
  }

  function errorBody(state: State): void {
    if (state.errorBodyStarted || state.entry.response.status < 400 || stopped) return;
    const headers = state.entry.response.headers;
    const length = header(headers, 'content-length');
    const encoding = header(headers, 'content-encoding');
    const mime = header(headers, 'content-type') ?? '';
    // Never retrieve an unbounded, compressed, successful or user-upload response body.
    if (
      !length ||
      !/^\d+$/.test(length) ||
      Number(length) > MAX_BODY ||
      Number(length) === 0 ||
      (encoding && encoding.toLowerCase() !== 'identity') ||
      !/(?:xml|text\/plain)/i.test(mime)
    ) {
      limitations.add(
        'Some provider error bodies were not read because their size or encoding could not be safely bounded.',
      );
      return;
    }
    state.errorBodyStarted = true;
    const work = (async () => {
      try {
        const result = await session.send('Network.getResponseBody', { requestId: state.cdpId });
        if (typeof result.body !== 'string' || result.body.length > MAX_BODY * 2) return;
        const body = result.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf8')
          : result.body;
        const code = providerCode(body);
        if (code) state.entry.response.content.text = `<Error><Code>${code}</Code></Error>`;
      } catch {
        limitations.add(
          'A provider error response was unavailable to the browser capture; its underlying cause may remain unknown.',
        );
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  function observed(event: {
    requestId: string;
    wallTime?: number;
    request: { url: string; method: string; headers: RawHeaders; postData?: string };
    redirectResponse?: { status: number; headers: RawHeaders };
    initiator?: { requestId?: string; type?: string };
  }): void {
    if (stopped) return;
    const previous = active.get(event.requestId);
    if (event.redirectResponse && previous) {
      const selected = safeHeaders(event.redirectResponse.headers);
      previous.entry.response.status = event.redirectResponse.status;
      previous.entry.response.headers = selected.headers;
      previous.entry._uploadDoctor.responseHeadersComplete = false;
      previous.entry._uploadDoctor.headersComplete = false;
      previous.terminal = true;
      previous.redirected = true;
      limitations.add(
        'Redirect chains are retained as separate attempts; complete header attribution is unavailable for redirected requests.',
      );
      active.delete(event.requestId);
    }
    const { request } = event;
    if (!storageHost(request.url, contract)) return;
    const selectedMethod =
      ['PUT', 'POST', 'OPTIONS'].includes(request.method) ||
      (contract !== undefined && new URL(request.url).searchParams.has('X-Amz-Signature'));
    if (!selectedMethod) return;
    if (request.url.length > MAX_URL) {
      boundedFailure();
      return;
    }
    if (
      (request.method !== 'OPTIONS' && uploads.length >= maxRequests) ||
      entries.length >= maxRequests * 3 + 16
    ) {
      truncated = true;
      limitations.add(
        'Capture request limit reached; additional upload or preflight attempts were not retained.',
      );
      return;
    }
    const selected = safeHeaders(request.headers);
    const entry: Entry = {
      startedDateTime: new Date((event.wallTime ?? Date.now() / 1_000) * 1_000).toISOString(),
      request: { url: request.url, method: request.method, headers: selected.headers },
      response: { status: 0, headers: [], content: { text: '' } },
      _uploadDoctor: {
        headersComplete: false,
        responseHeadersComplete: false,
        bodyKind: 'unknown',
        browserCorsError: false,
      },
    };
    // A bounded prefix can establish a multipart wrapper; it is never retained in evidence.
    const contentType = header(selected.headers, 'content-type') ?? '';
    const boundary = /\bboundary=(?:"([^"\r\n]{1,120})"|([^;\s]{1,120}))/i.exec(contentType);
    const bodyPrefix = typeof request.postData === 'string' ? request.postData.slice(0, 1_024) : '';
    if (
      /^multipart\/form-data\b/i.test(contentType) &&
      boundary &&
      bodyPrefix.startsWith(`--${boundary[1] ?? boundary[2]}\r\n`)
    ) {
      entry._uploadDoctor.bodyKind = 'form-data';
    } else if (
      typeof request.postData === 'string' &&
      request.postData.length <= 1_024 &&
      !/^multipart\/form-data\b/i.test(contentType)
    ) {
      entry._uploadDoctor.bodyKind = 'raw';
    }
    const state: State = {
      cdpId: event.requestId,
      id: request.method === 'OPTIONS' ? null : `upload-${uploads.length + 1}`,
      entry,
      terminal: false,
      redirected: event.redirectResponse !== undefined,
      errorBodyStarted: false,
      responseDelivered: false,
      serviceWorkerResponse: false,
    };
    active.set(event.requestId, state);
    entries.push(entry);
    if (state.id) uploads.push(state);
    else if (event.initiator?.type === 'preflight' && event.initiator.requestId) {
      preflightFor.set(event.initiator.requestId, state);
    }
  }

  const handlers: Array<[NetworkEvent, (event: any) => void]> = [];
  function listen(event: NetworkEvent, handler: (payload: any) => void): void {
    const guarded = (payload: unknown): void => {
      try {
        handler(payload);
      } catch {
        boundedFailure();
      }
    };
    handlers.push([event, guarded]);
    session.on(event, guarded);
  }
  listen('Network.requestWillBeSent', observed);
  listen(
    'Network.requestWillBeSentExtraInfo',
    (event: { requestId: string; headers: RawHeaders }) => {
      const state = active.get(event.requestId);
      if (!state || stopped || state.redirected) return;
      const selected = safeHeaders(event.headers);
      state.entry.request.headers = selected.headers;
      state.entry._uploadDoctor.headersComplete = selected.complete && !state.redirected;
    },
  );
  listen(
    'Network.responseReceived',
    (event: {
      requestId: string;
      response: { status: number; headers: RawHeaders; fromServiceWorker?: boolean };
    }) => {
      const state = active.get(event.requestId);
      if (!state || stopped) return;
      const selected = safeHeaders(event.response.headers);
      state.serviceWorkerResponse = event.response.fromServiceWorker === true;
      state.entry.response.status = state.serviceWorkerResponse ? 0 : event.response.status;
      state.entry.response.headers = selected.headers;
      state.entry._uploadDoctor.responseHeadersComplete =
        selected.complete && !state.redirected && !state.serviceWorkerResponse;
      state.responseDelivered = true;
      if (state.serviceWorkerResponse) {
        limitations.add(
          'A service worker supplied an upload response; the storage provider status and acceptance were not established.',
        );
      }
    },
  );
  listen(
    'Network.responseReceivedExtraInfo',
    (event: { requestId: string; statusCode: number; headers: RawHeaders }) => {
      const state = active.get(event.requestId);
      if (!state || stopped || state.redirected || state.serviceWorkerResponse) return;
      const selected = safeHeaders(event.headers);
      state.entry.response.status = event.statusCode;
      state.entry.response.headers = selected.headers;
      state.entry._uploadDoctor.responseHeadersComplete = selected.complete && !state.redirected;
    },
  );
  listen('Network.loadingFinished', (event: { requestId: string }) => {
    const state = active.get(event.requestId);
    if (!state || stopped) return;
    state.terminal = true;
    state.entry._uploadDoctor.browserCompleted = true;
    errorBody(state);
  });
  listen(
    'Network.loadingFailed',
    (event: {
      requestId: string;
      corsErrorStatus?: unknown;
      blockedReason?: string;
      errorText?: string;
    }) => {
      const state = active.get(event.requestId);
      if (!state || stopped) return;
      state.terminal = true;
      state.entry._uploadDoctor.browserCorsError =
        event.corsErrorStatus !== undefined || event.blockedReason === 'origin';
      if (
        state.responseDelivered &&
        event.errorText === 'net::ERR_ABORTED' &&
        !state.entry._uploadDoctor.browserCorsError
      ) {
        delete state.entry._uploadDoctor.browserCompleted;
        limitations.add(
          'A request was aborted after response headers arrived; the app may have left the response body unread, so full browser completion remains unknown.',
        );
      } else state.entry._uploadDoctor.browserCompleted = false;
      errorBody(state);
    },
  );

  const collector: CaptureCollector = {
    requests() {
      return uploads.map((state) => ({
        id: state.id!,
        method: state.entry.request.method,
        completed: state.terminal,
      }));
    },
    markApplicationSuccess(requestId, assertionId, success) {
      if (stopped) throw new Error('Cannot add an assertion after capture was finalized.');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(assertionId))
        throw new Error('Assertion ID must be a short identifier, without application data.');
      const state = uploads.find((upload) => upload.id === requestId);
      if (!state || !state.terminal)
        throw new Error('Application assertions require a specific completed upload attempt.');
      if (
        success &&
        (state.entry._uploadDoctor.browserCompleted === false ||
          !state.responseDelivered ||
          state.entry.response.status < 200 ||
          state.entry.response.status >= 300)
      ) {
        throw new Error(
          'Successful application assertions require an accepted upload with a delivered browser response.',
        );
      }
      if (state.entry._uploadDoctor.applicationAssertion !== undefined)
        throw new Error('An assertion has already been recorded for this upload attempt.');
      state.entry._uploadDoctor.applicationSuccess = success;
      state.entry._uploadDoctor.applicationAssertion = assertionId;
    },
    markResponseHeaderAccess(requestId, access) {
      if (stopped) throw new Error('Cannot add an assertion after capture was finalized.');
      const state = uploads.find((upload) => upload.id === requestId);
      if (
        !state ||
        !state.terminal ||
        !state.responseDelivered ||
        state.entry._uploadDoctor.browserCorsError ||
        state.entry.response.status < 200 ||
        state.entry.response.status >= 300
      ) {
        throw new Error(
          'Header-access assertions require a specific completed and accepted upload response.',
        );
      }
      const entries = Object.entries(access);
      if (
        entries.length === 0 ||
        entries.length > 128 ||
        entries.some(
          ([name, value]) =>
            !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i.test(name) || typeof value !== 'boolean',
        )
      ) {
        throw new Error(
          'Header-access evidence must contain bounded header names and boolean results.',
        );
      }
      if (state.entry._uploadDoctor.responseHeaderAccess !== undefined)
        throw new Error('Header-access evidence has already been recorded for this attempt.');
      state.entry._uploadDoctor.responseHeaderAccess = Object.fromEntries(
        entries.map(([name, value]) => [name.toLowerCase(), value]),
      );
    },
    finish() {
      if (finishing) return finishing;
      stopped = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      for (const [event, handler] of handlers) session.off(event, handler);
      finishing = (async () => {
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...pending]),
            new Promise<void>((resolve) => {
              waitTimer = setTimeout(resolve, 1_500);
            }),
          ]);
        } finally {
          if (waitTimer) clearTimeout(waitTimer);
          try {
            await session.detach();
          } catch {
            /* The page may already have closed. */
          }
        }
        if (pending.size)
          limitations.add(
            'Some provider response inspection did not finish within the capture deadline.',
          );
        if (uploads.some((state) => !state.terminal))
          limitations.add('Capture ended while at least one upload was incomplete.');
        const evidence = normalizeHar({ log: { entries } }, contract, { trustedBrowser: true });
        for (const request of evidence.requests) {
          // Browser evidence uses only explicit CDP causality, never HAR's URL/time heuristic.
          request.preflight = null;
          const state = uploads.find((upload) => upload.id === request.id);
          const preflight = state ? preflightFor.get(state.cdpId) : undefined;
          if (!preflight || preflight.entry.request.url !== state?.entry.request.url) continue;
          const preflightRequest = preflight.entry.request.headers;
          const origin = header(preflightRequest, 'origin');
          const method = header(preflightRequest, 'access-control-request-method');
          if (
            !origin ||
            (request.origin !== null && origin !== request.origin) ||
            method !== request.method
          )
            continue;
          if (request.origin === null) {
            // A blocked preflight means the provisional PUT may never receive wire headers.
            request.origin = origin;
            request.headers.origin = origin;
          }
          request.preflight = {
            status: preflight.entry.response.status || null,
            headers: Object.fromEntries(
              preflight.entry.response.headers.map(({ name, value }) => [name, value]),
            ),
            headersComplete: preflight.entry._uploadDoctor.responseHeadersComplete,
            requestedHeaders: (header(preflightRequest, 'access-control-request-headers') ?? '')
              .split(',')
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean),
            requestedMethod: method,
          };
        }
        if (evidence.requests.length && evidence.requests.every((request) => request.preflight)) {
          evidence.limitations = evidence.limitations.filter(
            (value) =>
              value !== 'Some preflight exchanges were not captured or could not be correlated.',
          );
        }
        evidence.source = 'browser';
        evidence.truncated ||= truncated;
        evidence.limitations = [...new Set([...evidence.limitations, ...limitations])];
        entries.length = 0;
        active.clear();
        preflightFor.clear();
        for (const state of uploads) {
          state.entry.request.url = '';
          state.entry.request.headers = [];
          state.entry.response.headers = [];
          state.entry.response.content.text = '';
        }
        return evidence;
      })();
      return finishing;
    },
  };
  function onAbort(): void {
    limitations.add('Capture was stopped by an abort signal.');
    void collector.finish();
  }
  try {
    await session.send('Network.enable', {
      maxTotalBufferSize: 1_048_576,
      maxResourceBufferSize: MAX_BODY,
      maxPostDataSize: 1_024,
    });
  } catch {
    await session.detach().catch(() => undefined);
    throw new Error('Could not enable Chromium network observation.');
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  timeout = setTimeout(() => {
    limitations.add('Capture reached its configured time limit.');
    void collector.finish();
  }, timeoutMs);
  timeout.unref?.();
  if (options.signal?.aborted) onAbort();
  return collector;
}

/** Opens a fresh isolated browser; the user performs the application upload themselves. */
export async function startCapture(options: StartCaptureOptions): Promise<CaptureSession> {
  // Check before importing Playwright, launching Chromium or visiting the target URL.
  requirePrivateCaptureEnvironment();
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new Error('Capture requires an absolute HTTP or HTTPS application URL.');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Capture requires an HTTP or HTTPS URL without embedded credentials.');
  }
  let browser: Browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: options.headless ?? false });
  } catch {
    throw new Error(
      'Browser capture requires Playwright and its Chromium browser. Install playwright and run: npx playwright install chromium',
    );
  }
  try {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const collector = await attachCapture(page, options);
    try {
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      await collector.finish();
      throw new Error(
        'The application page could not be opened. Check its address and connectivity.',
      );
    }
    let closed = false;
    return {
      page,
      ...collector,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await collector.finish();
        } finally {
          await browser.close();
        }
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

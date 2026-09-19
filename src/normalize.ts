import type { CaptureEvidence, Contract, Provider, RequestEvidence } from './types.js';
import { InputError, object, parseContract, safeUrl } from './validation.js';

export const MAX_ENTRIES = 10000;
export const MAX_UPLOADS = 1000;
export const PROVIDER_CODES = new Set([
  'ExpiredRequest',
  'RequestExpired',
  'ExpiredToken',
  'AccessDenied',
  'SignatureDoesNotMatch',
  'AuthorizationHeaderMalformed',
  'PermanentRedirect',
  'TemporaryRedirect',
  'BadDigest',
  'InvalidDigest',
  'ChecksumMismatch',
  'XAmzContentSHA256Mismatch',
  'IncorrectEndpoint',
  'InvalidRequest',
  'InvalidAccessKeyId',
  'RequestTimeTooSkewed',
  'RequestTimeout',
  'NoSuchBucket',
  'MethodNotAllowed',
  'NotImplemented',
]);
const VALUES = new Set([
  'origin',
  'content-type',
  'host',
  'access-control-request-method',
  'access-control-request-headers',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'x-amz-bucket-region',
]);
const TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const R2 = /(?:^|\.)[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/;

function isS3Host(host: string): boolean {
  const suffix = host.endsWith('.amazonaws.com.cn')
    ? '.amazonaws.com.cn'
    : host.endsWith('.amazonaws.com')
      ? '.amazonaws.com'
      : null;
  if (suffix === null) return false;
  // Parse labels once. A repeated group containing both a '-' separator and
  // '-' in its value alphabet makes near-miss hostnames exponentially costly.
  const labels = host.slice(0, -suffix.length).split('.');
  for (let index = labels.length - 1; index >= 0; index--) {
    const label = labels[index]!;
    if (!label || /[^a-z0-9-]/.test(label)) return false;
    if (label === 's3' || (label.startsWith('s3-') && label.length > 3)) return true;
  }
  return false;
}

export function providerForHost(host: string): Provider {
  if (R2.test(host)) return 'r2';
  if (isS3Host(host)) return 's3';
  return 'unknown';
}
function destination(url: URL, contract?: Contract): string | null {
  const provider = providerForHost(url.hostname);
  const r2Virtual = /^(.+)\.[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.exec(
    url.hostname,
  );
  if (provider === 'r2' && r2Virtual?.[1]) return r2Virtual[1];
  const pathStyle =
    provider === 'r2'
      ? true
      : provider === 's3'
        ? !/\.s3[.-]/.test(url.hostname)
        : contract?.pathStyle;
  if (pathStyle === false) return url.hostname;
  if (pathStyle !== true) return null;
  // Bucket names are private metadata; never preserve the following object path.
  const segment = url.pathname.split('/')[1];
  if (!segment) return null;
  try {
    const bucket = decodeURIComponent(segment);
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(bucket) ? bucket : null;
  } catch {
    return null;
  }
}
function iso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function headerMap(input: unknown): { values: Record<string, string>; completeShape: boolean } {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!Array.isArray(input)) return { values: result, completeShape: false };
  let complete = input.length <= 256;
  for (const item of input.slice(0, 256)) {
    if (!object(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
      complete = false;
      continue;
    }
    const name = item.name.toLowerCase();
    if (
      !TOKEN.test(name) ||
      item.value.length > 4096 ||
      /[\x00-\x08\x0a-\x1f\x7f]/.test(item.value)
    ) {
      complete = false;
      continue;
    }
    // Unknown values are unnecessary for diagnosis. Preserve presence only.
    const val = VALUES.has(name) ? item.value.trim() : '';
    result[name] = Object.hasOwn(result, name) ? `${result[name]},${val}` : val;
  }
  return { values: result, completeShape: complete };
}
function tokens(input: string | undefined): string[] {
  return (input ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => TOKEN.test(v))
    .slice(0, 256);
}
function code(content: unknown): string | null {
  if (!object(content) || typeof content.text !== 'string' || content.text.length > 16384)
    return null;
  let text = content.text;
  if (content.encoding === 'base64') {
    if (!/^[a-zA-Z0-9+/=\r\n]*$/.test(text)) return null;
    text = Buffer.from(text, 'base64').toString('utf8');
  } else if (content.encoding !== undefined && content.encoding !== '') return null;
  const match = /<Code>\s*([A-Za-z][A-Za-z0-9]{0,63})\s*<\/Code>/.exec(text);
  return match?.[1] && PROVIDER_CODES.has(match[1]) ? match[1] : null;
}
function status(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}
function signedDate(value: string | null): string | null {
  if (!value || !/^\d{8}T\d{6}Z$/.test(value)) return null;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  const parsed = iso(date);
  return parsed?.replace(/[-:]/g, '').replace('.000', '') === value ? parsed : null;
}
interface Candidate {
  entry: Record<string, unknown>;
  req: Record<string, unknown>;
  res: Record<string, unknown>;
  url: URL;
  method: string;
  index: number;
}

/** Imports HAR as evidence only. It never performs network requests or replays URLs. */
export function normalizeHar(
  input: unknown,
  contractInput?: Contract,
  options: { trustedBrowser?: boolean } = {},
): CaptureEvidence {
  const contract = contractInput ? parseContract(contractInput) : undefined;
  if (!object(input) || !object(input.log) || !Array.isArray(input.log.entries))
    throw new InputError('Invalid HAR: expected log.entries array.');
  const entries = input.log.entries;
  const limitations = new Set<string>();
  let truncated = entries.length > MAX_ENTRIES;
  const candidates: Candidate[] = [];
  for (const [index, entry] of entries.slice(0, MAX_ENTRIES).entries()) {
    if (!object(entry) || !object(entry.request)) {
      truncated = true;
      limitations.add('Malformed HAR entries were omitted.');
      continue;
    }
    const req = entry.request;
    const url = safeUrl(req.url);
    if (!url || typeof req.method !== 'string' || !/^[A-Z]{1,16}$/.test(req.method)) {
      truncated = true;
      limitations.add('Entries with invalid URLs or methods were omitted.');
      continue;
    }
    const recognized = providerForHost(url.hostname) !== 'unknown';
    if (contract ? !contract.storageHosts.includes(url.hostname) : !recognized) continue;
    if (
      !['PUT', 'POST', 'OPTIONS'].includes(req.method) &&
      !(contract && url.searchParams.has('X-Amz-Signature'))
    )
      continue;
    candidates.push({
      entry,
      req,
      res: object(entry.response) ? entry.response : {},
      url,
      method: req.method,
      index,
    });
  }
  const priorPreflights = new Map<string, Candidate>();
  const requests: RequestEvidence[] = [];
  for (const item of candidates) {
    if (item.method === 'OPTIONS') {
      const ph = headerMap(item.req.headers).values;
      priorPreflights.set(
        `${item.url.href}\0${ph.origin}\0${ph['access-control-request-method']}`,
        item,
      );
      continue;
    }
    if (requests.length >= MAX_UPLOADS) {
      truncated = true;
      break;
    }
    const { entry, req, res, url, method } = item;
    const h = headerMap(req.headers);
    const rh = headerMap(res.headers);
    const ext = options.trustedBrowser && object(entry._uploadDoctor) ? entry._uploadDoctor : {};
    const startedAt = iso(entry.startedDateTime);
    const rawOrigin = h.values.origin;
    const originUrl = safeUrl(rawOrigin);
    const origin =
      originUrl && originUrl.origin === rawOrigin
        ? originUrl.origin
        : rawOrigin === 'null'
          ? 'null'
          : null;
    const post = object(req.postData) ? req.postData : {};
    const mime =
      h.values['content-type'] ??
      (typeof post.mimeType === 'string' ? post.mimeType.slice(0, 256) : '');
    let bodyKind: RequestEvidence['bodyKind'] = 'unknown';
    // Presence of a declared MIME boundary alone is insufficient to prove actual bytes.
    if (typeof post.text === 'string' && post.text.length <= 16384) {
      const boundary = /(?:^|;)\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s]{1,70}))/i.exec(mime);
      if (
        /^multipart\/form-data(?:;|$)/i.test(mime) &&
        boundary &&
        post.text.startsWith(`--${boundary[1] ?? boundary[2]}\r\n`)
      )
        bodyKind = 'form-data';
      else if (!/^multipart\/form-data(?:;|$)/i.test(mime)) bodyKind = 'raw';
    }
    if (ext.bodyKind === 'raw' || ext.bodyKind === 'form-data') bodyKind = ext.bodyKind;
    const query = url.searchParams;
    const sigFields = [
      'X-Amz-Algorithm',
      'X-Amz-Signature',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
    ];
    const duplicateSignatureFields = sigFields.some((f) => query.getAll(f).length > 1);
    if (duplicateSignatureFields)
      limitations.add('Duplicate signing parameters prevent reliable signature metadata analysis.');
    const expiry = query.get('X-Amz-Expires');
    const expiresSeconds =
      expiry && /^\d{1,7}$/.test(expiry) && Number(expiry) <= 604800 ? Number(expiry) : null;
    const signatureVersion =
      !duplicateSignatureFields &&
      query.has('X-Amz-Signature') &&
      query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
        ? 'AWS4-HMAC-SHA256'
        : null;
    const signedHeaders = signatureVersion
      ? (query.get('X-Amz-SignedHeaders') ?? '')
          .split(';')
          .map((v) => v.toLowerCase())
          .filter((v) => TOKEN.test(v))
          .slice(0, 256)
      : [];
    const same = priorPreflights.get(`${url.href}\0${rawOrigin}\0${method}`);
    let preflight: RequestEvidence['preflight'] = null;
    if (same) {
      const ph = headerMap(same.req.headers).values;
      const stamp = iso(same.entry.startedDateTime);
      const elapsed = startedAt && stamp ? Date.parse(startedAt) - Date.parse(stamp) : null;
      const pfHeaders = headerMap(same.res.headers);
      const pfExt =
        options.trustedBrowser && object(same.entry._uploadDoctor) ? same.entry._uploadDoctor : {};
      if (
        elapsed !== null &&
        elapsed >= 0 &&
        elapsed <= 300000 &&
        ph['access-control-request-method'] === method
      )
        preflight = {
          status: status(same.res.status),
          headers: pfHeaders.values,
          headersComplete: pfExt.responseHeadersComplete === true && pfHeaders.completeShape,
          requestedHeaders: tokens(ph['access-control-request-headers']),
          requestedMethod: method,
        };
    }
    const responseHeaderAccess: Record<string, boolean> = Object.create(null) as Record<
      string,
      boolean
    >;
    if (object(ext.responseHeaderAccess))
      for (const [name, value] of Object.entries(ext.responseHeaderAccess).slice(0, 256)) {
        if (TOKEN.test(name) && typeof value === 'boolean') responseHeaderAccess[name] = value;
      }
    const assertion =
      typeof ext.applicationAssertion === 'string' &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(ext.applicationAssertion)
        ? ext.applicationAssertion
        : null;
    const region = rh.values['x-amz-bucket-region'];
    requests.push({
      id: `upload-${requests.length + 1}`,
      startedAt,
      method,
      endpoint: url.origin,
      destination: destination(url, contract),
      origin,
      provider: contract?.provider ?? providerForHost(url.hostname),
      headers: h.values,
      headersComplete: ext.headersComplete === true && h.completeShape,
      responseHeaders: rh.values,
      responseHeadersComplete: ext.responseHeadersComplete === true && rh.completeShape,
      status: status(res.status),
      providerCode: code(res.content),
      signedHeaders,
      signedAt: signatureVersion ? signedDate(query.get('X-Amz-Date')) : null,
      expiresSeconds: signatureVersion ? expiresSeconds : null,
      signatureVersion,
      temporaryCredentials: query.has('X-Amz-Security-Token'),
      bodyKind,
      multipart: query.has('uploadId') || query.has('partNumber') || query.has('uploads'),
      browserCorsError: ext.browserCorsError === true,
      browserCompleted: typeof ext.browserCompleted === 'boolean' ? ext.browserCompleted : null,
      preflight,
      redirectRegion: region && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : null,
      responseHeaderAccess: Object.keys(responseHeaderAccess).length ? responseHeaderAccess : null,
      applicationSuccess:
        assertion && typeof ext.applicationSuccess === 'boolean' ? ext.applicationSuccess : null,
      applicationAssertion: assertion,
    });
  }
  if (!options.trustedBrowser)
    limitations.add(
      'HAR does not prove browser or application completion; absent headers and cached preflights may be missing evidence.',
    );
  if (requests.some((r) => !r.preflight))
    limitations.add('Some preflight exchanges were not captured or could not be correlated.');
  if (requests.some((r) => r.bodyKind === 'unknown'))
    limitations.add('File content integrity was not verified.');
  if (truncated) limitations.add('Capture limits were reached; this report is incomplete.');
  if (!requests.length)
    limitations.add('No matching upload was captured; this is not a successful upload check.');
  return {
    source: options.trustedBrowser ? 'browser' : 'har',
    capturedAt: requests.at(-1)?.startedAt ?? new Date().toISOString(),
    requests,
    limitations: [...limitations],
    truncated,
  };
}

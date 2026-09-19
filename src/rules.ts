import type {
  CaptureEvidence,
  Contract,
  Finding,
  RequestEvidence,
  Status,
  Confidence,
} from './types.js';

const SOURCES = {
  signing: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html',
  cors: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html',
  r2: 'https://developers.cloudflare.com/r2/api/s3/presigned-urls/',
  r2Cors: 'https://developers.cloudflare.com/r2/buckets/cors/',
  form: 'https://github.com/aws/aws-sdk-js/issues/547',
  permissions: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html',
  checksum: 'https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html',
  region: 'https://aws.amazon.com/blogs/media/deep-dive-into-cors-configs-on-aws-s3-how-to/',
} as const;

const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
]);
const EXPIRED_CODES = new Set(['ExpiredRequest', 'RequestExpired']);
const CHECKSUM_CODES = new Set([
  'BadDigest',
  'InvalidDigest',
  'ChecksumMismatch',
  'XAmzContentSHA256Mismatch',
]);
const REGION_CODES = new Set([
  'AuthorizationHeaderMalformed',
  'IncorrectEndpoint',
  'PermanentRedirect',
  'TemporaryRedirect',
]);

export const RULE_IDS = [
  'upload-scope',
  'contract-method',
  'contract-content-type',
  'contract-body',
  'signed-headers',
  'url-expiry',
  'credential-expiry',
  'provider-rejection',
  'cors-preflight',
  'cors-origin',
  'cors-method',
  'cors-headers',
  'response-header-access',
  'region-redirect',
  'r2-endpoint',
  'body-integrity',
  'browser-outcome',
] as const;

function header(headers: Record<string, string>, name: string): string | undefined {
  const entries = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (entries.length === 0) return undefined;
  return entries
    .map(([, value]) => value)
    .join(',')
    .trim();
}

function list(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function time(value: string | null): number | null {
  if (value === null) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function matchesContract(
  request: RequestEvidence,
  contract: Contract | undefined,
): contract is Contract {
  const url = parsedUrl(request.endpoint);
  return (
    contract !== undefined &&
    url !== null &&
    contract.storageHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase()) &&
    (contract.provider === undefined || contract.provider === request.provider)
  );
}

function originRelationship(request: RequestEvidence): 'same' | 'cross' | 'unknown' {
  const endpoint = parsedUrl(request.endpoint);
  if (endpoint === null || request.origin === null) return 'unknown';
  if (request.origin === 'null') return 'cross';
  const origin = parsedUrl(request.origin);
  if (origin === null || origin.origin !== request.origin) return 'unknown';
  return origin.origin === endpoint.origin ? 'same' : 'cross';
}

/** All narrative text is fixed. Input identities are passed only in requestId for the report layer. */
export function diagnose(evidence: CaptureEvidence, contract?: Contract): Finding[] {
  const findings: Finding[] = [];
  for (const request of evidence.requests) {
    const add = (
      ruleId: string,
      status: Status,
      confidence: Confidence,
      title: string,
      observations: string[],
      explanation: string,
      recommendation: string,
      verification: string,
      source: string = SOURCES.signing,
    ): void => {
      findings.push({
        ruleId,
        requestId: request.id,
        status,
        confidence,
        title,
        evidence: observations,
        explanation,
        recommendation,
        verification,
        source,
      });
    };

    const activeContract = matchesContract(request, contract) ? contract : undefined;
    if (activeContract?.method !== undefined) {
      const matches = request.method.toUpperCase() === activeContract.method;
      add(
        'contract-method',
        matches ? 'pass' : 'fail',
        'confirmed',
        matches
          ? 'Request method matches the contract'
          : 'Request method differs from the contract',
        [
          matches
            ? 'The observed method agrees with the supplied contract.'
            : 'The observed method disagrees with the supplied contract.',
        ],
        'A presigned request must use the method chosen when signing. The contract is supplied evidence, not something decoded from the signature.',
        matches
          ? 'Keep the signer and uploader methods aligned.'
          : 'Use the method required by the signer, or generate a new URL for the intended operation.',
        'Capture another upload using the same contract and compare its observed method.',
      );
    }

    const endpoint = parsedUrl(request.endpoint);
    const usableEndpoint = endpoint !== null && ['http:', 'https:'].includes(endpoint.protocol);
    if (
      !usableEndpoint ||
      request.provider === 'unknown' ||
      request.signatureVersion !== 'AWS4-HMAC-SHA256' ||
      request.multipart ||
      request.method.toUpperCase() !== 'PUT'
    ) {
      const reason = !usableEndpoint
        ? 'The capture does not contain a valid HTTP storage endpoint.'
        : request.provider === 'unknown'
          ? 'The storage provider is not identified as S3 or R2.'
          : request.signatureVersion !== 'AWS4-HMAC-SHA256'
            ? 'A supported query-presigned Signature Version 4 request was not identified.'
            : request.multipart
              ? 'The capture describes a multipart upload operation.'
              : 'The observed operation is not a single PUT upload.';
      add(
        'upload-scope',
        'unsupported',
        'confirmed',
        'Upload is outside the supported diagnostic scope',
        [reason],
        'This version diagnoses single query-presigned Signature Version 4 PUT uploads to S3 and R2. It does not establish correctness for other upload protocols.',
        'Capture a supported upload, or inspect this protocol with its provider documentation.',
        'Confirm the provider, signing mode and operation before applying provider-specific findings.',
        request.provider === 'r2' ? SOURCES.r2 : SOURCES.signing,
      );
      continue;
    }

    add(
      'upload-scope',
      'pass',
      'confirmed',
      'Upload is within the supported diagnostic scope',
      ['The capture identifies an S3 or R2 query-presigned single PUT upload.'],
      'Scope recognition does not validate the signature, permissions, stored bytes or application outcome.',
      'Review each finding and the separate storage, browser and application outcomes.',
      'Retain a capture of the same application flow after any correction.',
    );

    if (request.provider === 'r2') {
      const nativeEndpoint = endpoint!.hostname.endsWith('.r2.cloudflarestorage.com');
      add(
        'r2-endpoint',
        nativeEndpoint ? 'pass' : 'fail',
        'confirmed',
        nativeEndpoint
          ? 'R2 signature uses an S3 API endpoint'
          : 'R2 signature uses an unsupported endpoint',
        [
          nativeEndpoint
            ? 'The identified R2 request targets its S3 API domain.'
            : 'The identified R2 request does not target its S3 API domain.',
        ],
        'R2 presigned URLs are supported on its S3 API domains, not custom domains. Provider identification must be established separately.',
        nativeEndpoint
          ? 'Keep the signer endpoint aligned with the R2 account.'
          : 'Generate a new presigned URL for the R2 S3 API endpoint instead of replacing the host in an existing URL.',
        'Capture the newly signed request at its intended R2 S3 API endpoint.',
        SOURCES.r2,
      );
    }

    if (activeContract?.contentType !== undefined) {
      const actual = header(request.headers, 'content-type');
      if (actual === undefined && !request.headersComplete) {
        add(
          'contract-content-type',
          'unknown',
          'unknown',
          'Request Content-Type cannot be checked',
          ['The capture does not contain Content-Type and request headers are incomplete.'],
          'An omitted captured header is not proof that the browser omitted the header.',
          'Capture complete request headers and compare them with the signer contract.',
          'Verify the observed Content-Type against the same contract.',
        );
      } else {
        const matches = actual === activeContract.contentType.trim();
        add(
          'contract-content-type',
          matches ? 'pass' : 'fail',
          'confirmed',
          matches
            ? 'Request Content-Type matches the contract'
            : 'Request Content-Type differs from the contract',
          [
            matches
              ? 'The captured Content-Type equals the contract value.'
              : 'Complete evidence shows a missing or different Content-Type.',
          ],
          'This compares the observed request with the supplied contract. A signature alone does not reveal the expected Content-Type value.',
          matches
            ? 'Keep the signer and uploader Content-Type values aligned.'
            : 'Send the contract Content-Type, or regenerate the signed request for the intended media type.',
          'Capture the corrected request and confirm the contract comparison passes.',
        );
      }
    } else {
      add(
        'contract-content-type',
        'unknown',
        'unknown',
        'Expected Content-Type is not established',
        ['No matching contract supplies an expected Content-Type.'],
        'Signed header names do not reveal their expected values. A media type mismatch cannot be reconstructed from a signature.',
        'Supply a contract for this storage host if the signer requires a particular Content-Type.',
        'Compare the next capture with the signer contract.',
      );
    }

    if (activeContract?.body === 'raw' && request.bodyKind === 'form-data') {
      add(
        'contract-body',
        'fail',
        'confirmed',
        'FormData body violates the raw-body contract',
        ['The contract requires raw file bytes.', 'The captured body is form data.'],
        'A raw PUT can store the multipart form wrapper along with the file. A successful HTTP response alone does not prove the intended file was stored.',
        'Send the File or Blob itself as the PUT body instead of wrapping it in FormData.',
        'Repeat with a disposable test file and verify the stored bytes through an authorized read.',
        SOURCES.form,
      );
    } else if (activeContract?.body === 'raw' && request.bodyKind === 'raw') {
      add(
        'contract-body',
        'pass',
        'confirmed',
        'Body shape matches the raw-body contract',
        ['The capture identifies a raw body and the contract requires a raw body.'],
        'Body shape does not establish byte-for-byte integrity.',
        'Keep sending the file directly.',
        'Verify stored bytes separately when integrity is part of the application requirement.',
        SOURCES.form,
      );
    } else if (request.bodyKind === 'form-data' && activeContract?.body !== 'any') {
      add(
        'contract-body',
        'fail',
        'likely',
        'FormData may be stored as the uploaded object',
        [
          'The single PUT request contains form data.',
          'No matching contract establishes that this wrapper is intentional.',
        ],
        'Single-object PUT uploads usually expect file bytes. Form data may instead store multipart boundaries as object content.',
        'Check the signer contract and send the File or Blob directly if raw file bytes are intended.',
        'Compare a disposable test object with the original file through an authorized read.',
        SOURCES.form,
      );
    } else if (activeContract?.body === 'any') {
      add(
        'contract-body',
        'pass',
        'confirmed',
        'Contract does not restrict body shape',
        ['The matching contract permits any body shape.'],
        'This does not verify the content stored by the provider.',
        'Use a separate integrity assertion if exact bytes matter.',
        'Verify stored bytes through an authorized read.',
        SOURCES.form,
      );
    } else {
      add(
        'contract-body',
        'unknown',
        'unknown',
        'Body shape requirements are not established',
        ['A raw-body contract or conclusive body-shape capture is unavailable.'],
        'The evidence cannot establish whether the intended file bytes were sent directly.',
        'Capture the body shape and supply a matching raw-body contract when appropriate.',
        'Repeat the same upload flow and check the body-shape finding.',
        SOURCES.form,
      );
    }

    const declared = request.signedHeaders.map((name) => name.toLowerCase());
    const missing = declared.filter(
      (name) => name !== 'host' && header(request.headers, name) === undefined,
    );
    if (declared.length === 0 || (missing.length > 0 && !request.headersComplete)) {
      add(
        'signed-headers',
        'unknown',
        'unknown',
        'Required signed headers cannot be fully checked',
        [
          declared.length === 0
            ? 'Signed header names are not available.'
            : 'Some signed header names are absent from an incomplete capture.',
        ],
        'Missing captured headers do not prove missing transmitted headers. The request URL supplies Host implicitly.',
        'Capture complete request headers and retain the signer contract for value comparisons.',
        'Check the complete captured request against its declared signed header names.',
      );
    } else {
      const absent = missing.length > 0;
      add(
        'signed-headers',
        absent ? 'fail' : 'pass',
        'confirmed',
        absent ? 'A required signed header is missing' : 'Declared signed header names are present',
        [
          absent
            ? 'Complete request headers omit a name required by the signature.'
            : 'Every declared signed header name is present, with Host supplied by the URL.',
        ],
        'This checks header presence only. Expected signed values and signature validity are not determined.',
        absent
          ? 'Send every header required by the signer with its original value, or regenerate the signed request.'
          : 'Preserve these headers and verify their values against the signer contract.',
        'Capture complete request headers after the change and repeat this check.',
      );
    }

    const signedAt = time(request.signedAt);
    const startedAt = time(request.startedAt);
    const expires = request.expiresSeconds;
    if (request.providerCode !== null && EXPIRED_CODES.has(request.providerCode)) {
      add(
        'url-expiry',
        'fail',
        'confirmed',
        'Provider rejected the URL as expired',
        ['The provider error identifies request expiration.'],
        request.provider === 'r2'
          ? 'R2 can omit CORS headers from expired-URL responses. A browser CORS error can therefore be secondary to expiration.'
          : 'The provider rejected the request validity window. Changing CORS alone does not repair an expired URL.',
        'Generate a fresh URL immediately before upload and refresh it before retrying an expired request.',
        'Repeat the same application upload with a fresh URL and verify the provider accepts it.',
        request.provider === 'r2' ? SOURCES.r2Cors : SOURCES.signing,
      );
    } else if (
      signedAt === null ||
      startedAt === null ||
      expires === null ||
      !Number.isInteger(expires) ||
      expires < 0 ||
      expires > 604800
    ) {
      add(
        'url-expiry',
        'unknown',
        'unknown',
        'Advertised URL lifetime cannot be checked',
        ['A valid signing time, request time or expiration interval is missing.'],
        'Capture time is not a substitute for the time the request was made.',
        'Retain request timing and signing-window evidence in the next capture.',
        'Compare request time with the advertised signing window.',
      );
    } else {
      const outside = startedAt < signedAt || startedAt >= signedAt + expires * 1000;
      add(
        'url-expiry',
        outside ? 'fail' : 'pass',
        outside ? 'likely' : 'confirmed',
        outside
          ? 'Request time is outside the advertised signing window'
          : 'Request time is within the advertised signing window',
        [
          outside
            ? 'Captured request timing falls outside the declared interval.'
            : 'Captured request timing falls inside the declared interval.',
        ],
        outside
          ? 'Clock differences can affect this comparison. A provider expiration response is stronger evidence.'
          : 'This checks only the advertised window. Credentials, revocation and provider policies may shorten actual validity.',
        outside
          ? 'Check clock synchronization and generate a fresh URL immediately before upload.'
          : 'Continue checking signing credentials and provider responses.',
        'Capture a new request with synchronized clocks and inspect the provider result.',
      );
    }

    if (request.providerCode === 'ExpiredToken') {
      add(
        'credential-expiry',
        'fail',
        'confirmed',
        'Signing credentials expired before the request',
        ['The provider returned its expired-token error.'],
        'A URL cannot remain valid after the signing credentials expire, even when its advertised window has time remaining.',
        'Refresh signing credentials and generate a new URL. Keep URL lifetime within the credential lifetime.',
        'Repeat using freshly obtained signing credentials and a newly signed URL.',
      );
    } else if (request.status !== null && request.status >= 200 && request.status < 300) {
      add(
        'credential-expiry',
        'pass',
        'confirmed',
        'Provider accepted the signing credentials for this request',
        ['The query-presigned storage request received a successful HTTP response.'],
        'This establishes acceptance for the observed request, not the future lifetime or revocation state of the credentials.',
        'Keep refreshing temporary signing credentials before generating new URLs.',
        'Verify the same application flow succeeds with a freshly generated URL.',
      );
    } else {
      add(
        'credential-expiry',
        'unknown',
        'unknown',
        'Signing credential validity is not established',
        [
          request.temporaryCredentials
            ? 'The signature indicates temporary credentials; their expiration is not exposed here.'
            : 'The capture does not establish credential lifetime or revocation state.',
        ],
        'URL timestamps cannot prove that the signing credentials remain valid.',
        'Inspect the signer credential refresh path if the provider rejects an otherwise timely request.',
        'Check a fresh provider response without exposing signing credentials.',
      );
    }

    if (request.providerCode === 'AccessDenied') {
      add(
        'provider-rejection',
        'fail',
        'confirmed',
        'Provider denied authorization; policy cause is unknown',
        ['The provider returned AccessDenied.'],
        'A generic denial does not identify the responsible policy, credential permission, network restriction or encryption requirement.',
        'Inspect the denied operation and provider audit or enhanced error context. Avoid broad permission changes based only on this response.',
        'Repeat with the intended identity and scoped authorization after the responsible restriction is established.',
        SOURCES.permissions,
      );
    } else if (request.providerCode === 'SignatureDoesNotMatch') {
      add(
        'provider-rejection',
        'fail',
        'confirmed',
        'Provider rejected the signature; exact cause is unknown',
        ['The provider returned its signature-mismatch error.'],
        'The error alone does not distinguish a changed method, header, query string, endpoint or signing error.',
        'Compare the actual request with the signer contract and regenerate the URL after correcting any mismatch.',
        'Capture the unchanged signed request as transmitted and verify the provider accepts it.',
      );
    } else if (request.providerCode !== null && CHECKSUM_CODES.has(request.providerCode)) {
      add(
        'provider-rejection',
        'fail',
        'confirmed',
        'Provider rejected request integrity evidence',
        ['The provider returned a checksum or content-digest error.'],
        'This confirms an integrity-related rejection, not the exact source of the wrong value. SDK checksum defaults may change across versions.',
        'Compare the checksum and signed headers with the actual bytes sent. Check SDK and endpoint compatibility before changing integrity settings.',
        'Repeat with a known disposable payload and a matching checksum.',
        SOURCES.checksum,
      );
    } else if (request.status !== null && request.status >= 200 && request.status < 300) {
      add(
        'provider-rejection',
        'pass',
        'confirmed',
        'Storage returned a successful HTTP status',
        ['The observed storage response is a successful HTTP response.'],
        'HTTP acceptance does not establish readable response headers, stored-byte integrity or application completion.',
        'Check browser and application outcomes separately.',
        'Verify the same flow reaches the application success assertion.',
      );
    } else if (request.status !== null && request.status >= 400) {
      add(
        'provider-rejection',
        'fail',
        'unknown',
        'Storage rejected the request',
        ['The observed storage HTTP response indicates failure.'],
        'The available response does not establish a more specific cause in this diagnostic rule.',
        'Inspect the provider response and related findings without guessing a permission or CORS change.',
        'Retain the next provider response and verify the same upload is accepted.',
      );
    } else {
      add(
        'provider-rejection',
        'unknown',
        'unknown',
        'Storage acceptance is not established',
        ['No conclusive successful or rejected storage response is available.'],
        'A browser failure or missing response is not proof that the provider rejected the request.',
        'Capture the storage response and distinguish network, browser and application outcomes.',
        'Repeat the same flow with response evidence available.',
      );
    }

    diagnoseCors(request, activeContract, add);

    add(
      'browser-outcome',
      request.browserCompleted === false
        ? 'fail'
        : request.browserCompleted === true
          ? 'pass'
          : 'unknown',
      request.browserCompleted === null ? 'unknown' : 'confirmed',
      request.browserCompleted === false
        ? 'Browser did not complete the upload request'
        : request.browserCompleted === true
          ? 'Browser completed the upload request'
          : 'Browser completion is not established',
      [
        request.browserCompleted === false
          ? 'The browser reported a failed request.'
          : request.browserCompleted === true
            ? 'The browser reported request completion.'
            : 'Complete browser transport evidence is unavailable.',
      ],
      'A browser failure can result from transport, cancellation, TLS or CORS. This finding does not infer a bucket configuration cause or prove application completion.',
      request.browserCompleted === false
        ? 'Inspect the browser network failure and related provider findings, then repeat the same application action.'
        : 'Check the provider response and correlated application assertion separately.',
      'Observe a completed request and the same application success assertion in a fresh capture.',
      SOURCES.cors,
    );

    const redirect = request.status !== null && [301, 302, 303, 307, 308].includes(request.status);
    if (redirect || (request.providerCode !== null && REGION_CODES.has(request.providerCode))) {
      add(
        'region-redirect',
        'fail',
        'likely',
        'Endpoint or signing region requires inspection',
        [
          redirect
            ? 'The storage response is a redirect.'
            : 'The capture includes an endpoint or signing-region diagnostic.',
        ],
        'A redirect or region hint can identify an endpoint mismatch, but it does not by itself establish the correct signer configuration.',
        'Verify the bucket endpoint and signing region, then generate a fresh URL. Do not rewrite a signed URL or blindly follow redirects.',
        'Capture a newly signed upload that reaches its intended storage endpoint without a redirect.',
        SOURCES.region,
      );
    } else {
      add(
        'region-redirect',
        request.status === null ? 'unknown' : 'pass',
        request.status === null ? 'unknown' : 'confirmed',
        request.status === null
          ? 'Endpoint response is unavailable'
          : 'No endpoint redirect was observed',
        [
          request.status === null
            ? 'The storage response was not captured.'
            : 'The captured response contains no recognized redirect or endpoint-error diagnostic.',
        ],
        'A region response header alone does not establish an endpoint mismatch. Absence of an endpoint error does not validate all signer settings.',
        'Review signer endpoint settings if signature errors remain.',
        'Retain the response from a newly signed upload.',
        SOURCES.region,
      );
    }

    add(
      'body-integrity',
      'unknown',
      'unknown',
      'Stored bytes have not been verified',
      ['The diagnostic does not download or inspect the stored object.'],
      'HTTP success and an ETag do not establish that the stored object equals the intended file.',
      'Use an independently authorized read or application checksum assertion when exact stored bytes must be verified.',
      'Compare a disposable stored object with the original bytes without reusing a PUT URL for a different operation.',
      SOURCES.checksum,
    );
  }
  return findings;
}

type AddFinding = (
  ruleId: string,
  status: Status,
  confidence: Confidence,
  title: string,
  observations: string[],
  explanation: string,
  recommendation: string,
  verification: string,
  source?: string,
) => void;

function diagnoseCors(
  request: RequestEvidence,
  contract: Contract | undefined,
  add: AddFinding,
): void {
  const relationship = originRelationship(request);
  const preflight = request.preflight;
  const accepted = request.status !== null && request.status >= 200 && request.status < 300;
  const browserSucceeded = request.browserCompleted === true;

  if (relationship === 'same') {
    for (const ruleId of ['cors-preflight', 'cors-origin', 'cors-method', 'cors-headers']) {
      add(
        ruleId,
        'pass',
        'confirmed',
        'CORS permission is not needed for this same-origin request',
        ['The captured request origin and storage endpoint origin match.'],
        'This finding addresses CORS only; signing and application outcomes still require separate checks.',
        'Inspect the remaining upload findings.',
        'Verify the same application flow completes.',
        SOURCES.cors,
      );
    }
  } else {
    if (preflight?.status !== null && preflight?.status !== undefined) {
      const success = preflight.status >= 200 && preflight.status < 300;
      add(
        'cors-preflight',
        success ? 'pass' : 'fail',
        'confirmed',
        success
          ? 'Preflight returned a successful HTTP status'
          : 'Preflight did not return a successful HTTP status',
        [
          success
            ? 'The captured OPTIONS response was successful.'
            : 'The captured OPTIONS response was rejected or redirected.',
        ],
        'HTTP status alone does not establish CORS permissions or identify the cause of a rejected preflight.',
        success
          ? 'Check the returned origin, method and header permissions.'
          : 'Inspect the preflight response and endpoint before changing bucket CORS settings.',
        'Capture an OPTIONS response that succeeds and grants the actual request permissions.',
        SOURCES.cors,
      );
    } else {
      add(
        'cors-preflight',
        'unknown',
        'unknown',
        'Preflight result was not observed',
        ['No conclusive OPTIONS response is available.'],
        'A browser may use a cached preflight result. Missing capture evidence does not prove a missing or failed preflight.',
        'Capture the browser network flow when preflight evidence is needed.',
        'Inspect the OPTIONS exchange or confirm the browser completes the actual request.',
        SOURCES.cors,
      );
    }

    const originChecks: { value: string | undefined; complete: boolean }[] = [];
    if (request.status !== null)
      originChecks.push({
        value: header(request.responseHeaders, 'access-control-allow-origin'),
        complete: request.responseHeadersComplete,
      });
    if (preflight !== null && preflight.status !== null)
      originChecks.push({
        value: header(preflight.headers, 'access-control-allow-origin'),
        complete: preflight.headersComplete === true,
      });
    const originWrong =
      relationship === 'cross' &&
      originChecks.some(
        ({ value, complete }) =>
          (value === undefined && complete) ||
          (value !== undefined && value !== '*' && value !== request.origin),
      );
    if (originWrong) {
      add(
        'cors-origin',
        'fail',
        'confirmed',
        'A captured response does not permit the request origin',
        [
          'A response has a conflicting origin permission or complete headers omit that permission.',
        ],
        'This confirms a response-level CORS problem. An expired URL, authorization error or endpoint failure may be the underlying cause; bucket misconfiguration is not established.',
        'Resolve provider errors first. For a valid upload response, allow the exact application origin in the relevant CORS rule.',
        'Repeat the same flow and confirm the browser receives an accessible storage response.',
        SOURCES.r2Cors,
      );
    } else if (browserSucceeded) {
      add(
        'cors-origin',
        'pass',
        'confirmed',
        'Browser completed the storage request',
        ['The browser reported a completed request.'],
        'Browser completion is stronger than inferring success from CORS configuration alone. It does not prove application completion.',
        'Keep checking any required response headers and the application result.',
        'Verify the same application success assertion.',
        SOURCES.cors,
      );
    } else {
      add(
        'cors-origin',
        'unknown',
        'unknown',
        'Browser origin permission is not fully established',
        ['The evidence does not confirm browser access to the storage response.'],
        'Missing headers in an incomplete capture, unknown origins and wildcard credential semantics limit conclusions.',
        'Capture complete browser evidence and compare the actual origin with returned CORS permissions.',
        'Confirm that the browser completes the same storage request.',
        SOURCES.cors,
      );
    }

    for (const kind of ['method', 'headers'] as const) {
      const permission = header(
        preflight?.headers ?? {},
        kind === 'method' ? 'access-control-allow-methods' : 'access-control-allow-headers',
      );
      const allowed =
        kind === 'method'
          ? (permission
              ?.split(',')
              .map((item) => item.trim())
              .filter(Boolean) ?? [])
          : list(permission);
      const required =
        kind === 'method'
          ? preflight?.requestedMethod
            ? [preflight.requestedMethod]
            : []
          : (preflight?.requestedHeaders ?? []).map((name) => name.toLowerCase());
      const mismatch =
        (permission !== undefined || preflight?.headersComplete === true) &&
        !allowed.includes('*') &&
        required.some((value) => !allowed.includes(value));
      const knownAllowed =
        permission !== undefined &&
        !allowed.includes('*') &&
        required.length > 0 &&
        required.every((value) => allowed.includes(value));
      add(
        `cors-${kind}`,
        mismatch ? 'fail' : knownAllowed || browserSucceeded ? 'pass' : 'unknown',
        mismatch || knownAllowed || browserSucceeded ? 'confirmed' : 'unknown',
        mismatch
          ? kind === 'method'
            ? 'Preflight permissions exclude the requested method'
            : 'Preflight permissions exclude a requested header'
          : knownAllowed || browserSucceeded
            ? kind === 'method'
              ? 'Method permission is supported by the capture'
              : 'Request-header permission is supported by the capture'
            : kind === 'method'
              ? 'Preflight method permission is not established'
              : 'Preflight request-header permission is not established',
        [
          mismatch
            ? 'An explicit permission list excludes part of the captured preflight request.'
            : knownAllowed
              ? 'The explicit permission list covers the captured preflight request.'
              : browserSucceeded
                ? 'The browser completed the actual request.'
                : 'The capture lacks sufficient explicit permissions or browser completion evidence.',
        ],
        'This compares the captured preflight with the returned permission list. A rejected preflight may have a separate provider or endpoint cause.',
        mismatch
          ? 'Allow only the method or headers actually required by the application after resolving provider errors.'
          : 'Retain complete preflight evidence when diagnosing browser-only failures.',
        'Repeat the same browser request and verify the matching preflight permissions.',
        SOURCES.cors,
      );
    }
  }

  const required = contract?.requiredResponseHeaders?.map((name) => name.toLowerCase()) ?? [];
  if (required.length === 0) {
    add(
      'response-header-access',
      'unknown',
      'unknown',
      'Required response headers are not specified',
      ['No matching contract declares response-header requirements.'],
      'The diagnostic cannot infer which response headers the application must read.',
      'Declare required response headers in a contract if application completion depends on them.',
      'Capture the browser reading those headers after upload.',
      SOURCES.cors,
    );
    return;
  }
  const access = (name: string): boolean | undefined => {
    const entry = Object.entries(request.responseHeaderAccess ?? {}).find(
      ([key]) => key.toLowerCase() === name,
    );
    return entry?.[1];
  };
  if (accepted && required.some((name) => access(name) === false)) {
    add(
      'response-header-access',
      'fail',
      'confirmed',
      'Browser could not read a required response header',
      [
        'Storage accepted the request.',
        'Browser evidence records a required header as unavailable.',
      ],
      'This does not by itself distinguish an absent provider header from a header hidden by CORS.',
      'Check whether the provider sent the header, then expose required non-safelisted headers for the application origin when needed.',
      'Repeat the upload and confirm the browser can read every required header.',
      SOURCES.cors,
    );
  } else if (accepted && required.every((name) => access(name) === true)) {
    add(
      'response-header-access',
      'pass',
      'confirmed',
      'Browser read every required response header',
      ['Storage accepted the request and direct browser evidence confirms header access.'],
      'Header readability does not establish stored-byte integrity or application success.',
      'Check the separate application result.',
      'Verify the same application success assertion.',
      SOURCES.cors,
    );
  } else if (
    accepted &&
    relationship === 'cross' &&
    request.responseHeadersComplete &&
    required.some((name) => {
      if (access(name) === true || SAFE_RESPONSE_HEADERS.has(name)) return false;
      const exposed = list(header(request.responseHeaders, 'access-control-expose-headers'));
      return (
        header(request.responseHeaders, name) === undefined ||
        (!exposed.includes(name) && !exposed.includes('*'))
      );
    })
  ) {
    add(
      'response-header-access',
      'fail',
      'likely',
      'A required response header may be unavailable to the browser',
      [
        'Storage accepted the request.',
        'Complete response headers omit a required header or do not expose it for cross-origin access.',
      ],
      'This is inferred from network headers. It is not direct proof of what application JavaScript read.',
      'Check provider header presence and expose the required non-safelisted header for the application origin.',
      'Capture direct browser header access after the correction.',
      SOURCES.cors,
    );
  } else {
    add(
      'response-header-access',
      'unknown',
      'unknown',
      'Required response-header access is not established',
      [
        'The capture does not confirm browser access to every required header after an accepted upload.',
      ],
      'Network header presence or an exposure declaration alone does not prove application JavaScript accessed the header.',
      'Capture direct browser header access during the same application flow.',
      'Confirm every required header is readable after storage accepts the request.',
      SOURCES.cors,
    );
  }
}

import { diagnose } from '../dist/rules.js';

export const contract = {
  version: 1,
  id: 'test-upload',
  storageHosts: ['bucket.s3.us-east-1.amazonaws.com'],
  provider: 's3',
  method: 'PUT',
  contentType: 'image/png',
  body: 'raw',
  requiredResponseHeaders: ['ETag'],
};

export function request(patch = {}) {
  return {
    id: 'request-1',
    startedAt: '2026-09-19T12:01:00Z',
    method: 'PUT',
    endpoint: 'https://bucket.s3.us-east-1.amazonaws.com/object',
    origin: 'https://app.example',
    provider: 's3',
    headers: { 'content-type': 'image/png' },
    headersComplete: true,
    responseHeaders: {
      'access-control-allow-origin': 'https://app.example',
      'access-control-expose-headers': 'ETag',
      etag: '',
    },
    responseHeadersComplete: true,
    status: 200,
    providerCode: null,
    signedHeaders: ['host', 'content-type'],
    signedAt: '2026-09-19T12:00:00Z',
    expiresSeconds: 300,
    signatureVersion: 'AWS4-HMAC-SHA256',
    temporaryCredentials: false,
    bodyKind: 'raw',
    multipart: false,
    browserCorsError: false,
    browserCompleted: true,
    preflight: {
      status: 200,
      headers: {
        'access-control-allow-origin': 'https://app.example',
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': 'Content-Type',
      },
      headersComplete: true,
      requestedHeaders: ['content-type'],
      requestedMethod: 'PUT',
    },
    redirectRegion: null,
    responseHeaderAccess: { etag: true },
    applicationSuccess: true,
    applicationAssertion: 'upload-complete',
    ...patch,
  };
}

export function findings(patch = {}, selectedContract = contract) {
  return diagnose(
    {
      source: 'browser',
      capturedAt: '2026-09-19T12:02:00Z',
      requests: [request(patch)],
      limitations: [],
      truncated: false,
    },
    selectedContract ?? undefined,
  );
}

export function finding(ruleId, patch = {}, selectedContract = contract) {
  const result = findings(patch, selectedContract).find((item) => item.ruleId === ruleId);
  if (!result) throw new Error(`Missing rule in test fixture: ${ruleId}`);
  return result;
}

export function preflight(patch = {}) {
  return { ...request().preflight, ...patch };
}

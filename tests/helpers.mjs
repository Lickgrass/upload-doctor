export const account = '0123456789abcdef0123456789abcdef';
export const endpoint = `https://${account}.r2.cloudflarestorage.com`;
export const contract = {
  version: 1,
  id: 'avatar',
  storageHosts: [`${account}.r2.cloudflarestorage.com`],
  provider: 'r2',
  method: 'PUT',
  body: 'raw',
  contentType: 'text/plain',
};
export function signedUrl(overrides = {}) {
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'CANARY_ACCESS_KEY/20260919/auto/s3/aws4_request',
    'X-Amz-Date': '20260919T120000Z',
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host;content-type',
    'X-Amz-Signature': 'CANARY_BEARER_SECRET',
    'X-Amz-Security-Token': 'CANARY_SESSION_SECRET',
    ...overrides,
  });
  return `${endpoint}/private-bucket/CANARY_FILE_NAME.txt?${query}`;
}
export function headers(value) {
  return Object.entries(value).map(([name, value]) => ({ name, value }));
}
export function entry(overrides = {}) {
  return {
    startedDateTime: '2026-09-19T12:01:00.000Z',
    request: {
      method: 'PUT',
      url: signedUrl(),
      headers: headers({
        origin: 'https://app.example',
        'content-type': 'text/plain',
        authorization: 'CANARY_AUTH_SECRET',
        cookie: 'CANARY_COOKIE_SECRET',
      }),
      postData: { mimeType: 'text/plain', text: 'CANARY_FILE_BYTES' },
    },
    response: {
      status: 200,
      headers: headers({
        'access-control-allow-origin': 'https://app.example',
        etag: 'CANARY_PRIVATE_ETAG',
        'set-cookie': 'CANARY_RESPONSE_SECRET',
      }),
      content: { text: 'CANARY_RESPONSE_BODY' },
    },
    ...overrides,
  };
}
export function har(...entries) {
  return { log: { version: '1.2', entries: entries.length ? entries : [entry()] } };
}

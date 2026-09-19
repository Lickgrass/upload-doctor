import type { Contract } from './types.js';

/** Messages are deliberately fixed: parsing errors must not echo secret input. */
export class InputError extends Error {
  constructor(message = 'Invalid input. See the documented input format.') {
    super(message);
    this.name = 'InputError';
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
export function hostname(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253 || /[/@?#\s]/.test(value)) return null;
  const url = safeUrl(`https://${value}`);
  return url && !url.port && url.hostname.toLowerCase() === value.toLowerCase()
    ? url.hostname.toLowerCase()
    : null;
}
export function parseContract(value: unknown): Contract {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'version',
          'id',
          'storageHosts',
          'provider',
          'method',
          'body',
          'contentType',
          'requiredResponseHeaders',
          'pathStyle',
        ].includes(k),
    )
  )
    throw new InputError('Invalid contract: unknown field or invalid object.');
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)
  )
    throw new InputError('Invalid contract: version must be 1 and id must be a short identifier.');
  if (
    !Array.isArray(value.storageHosts) ||
    value.storageHosts.length < 1 ||
    value.storageHosts.length > 32 ||
    value.storageHosts.some((h) => !hostname(h))
  )
    throw new InputError('Invalid contract: storageHosts must contain 1–32 bare hostnames.');
  const result: Contract = {
    version: 1,
    id: value.id,
    storageHosts: [...new Set(value.storageHosts.map((h) => hostname(h)!))].sort(),
  };
  if (value.provider !== undefined) {
    if (value.provider !== 's3' && value.provider !== 'r2')
      throw new InputError('Invalid contract provider.');
    result.provider = value.provider;
  }
  if (value.method !== undefined) {
    if (value.method !== 'PUT') throw new InputError('The supported contract method is PUT.');
    result.method = value.method;
  }
  if (value.body !== undefined) {
    if (value.body !== 'raw' && value.body !== 'any')
      throw new InputError('Invalid contract body requirement.');
    result.body = value.body;
  }
  if (value.pathStyle !== undefined) {
    if (typeof value.pathStyle !== 'boolean') throw new InputError('Invalid contract pathStyle.');
    result.pathStyle = value.pathStyle;
  }
  if (value.contentType !== undefined) {
    if (
      typeof value.contentType !== 'string' ||
      value.contentType.length > 256 ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(value.contentType)
    )
      throw new InputError('Invalid contract contentType.');
    result.contentType = value.contentType;
  }
  if (value.requiredResponseHeaders !== undefined) {
    if (
      !Array.isArray(value.requiredResponseHeaders) ||
      value.requiredResponseHeaders.length > 32 ||
      value.requiredResponseHeaders.some(
        (h) =>
          typeof h !== 'string' ||
          !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(h) ||
          ['set-cookie', 'set-cookie2', 'authorization', 'cookie', 'x-api-key'].includes(
            h.toLowerCase(),
          ),
      )
    )
      throw new InputError('Invalid contract requiredResponseHeaders.');
    result.requiredResponseHeaders = [
      ...new Set((value.requiredResponseHeaders as string[]).map((h) => h.toLowerCase())),
    ].sort();
  }
  return result;
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError('Input is not valid JSON.');
  }
}

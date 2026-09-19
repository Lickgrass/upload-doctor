import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { InputError, parseJson } from './validation.js';

export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export async function readJsonFile(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES)
      throw new InputError('Input must be a regular file of at most 32 MiB.');
    // Bound actual reads as well as the initial stat: the file may change concurrently.
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_INPUT_BYTES) {
      const buffer = Buffer.alloc(Math.min(65536, MAX_INPUT_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (size > MAX_INPUT_BYTES) throw new InputError('Input exceeds the 32 MiB limit.');
    const bytes = Buffer.concat(chunks);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new InputError('Input must be valid UTF-8 JSON.');
    }
    return parseJson(text);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      'Cannot read input file. Check that it is a readable regular file and not a symbolic link.',
    );
  } finally {
    await handle?.close();
  }
}
/** Exclusive creation prevents accidental overwrite and symlink replacement. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  let handle;
  let created = false;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(path).catch(() => undefined);
    throw new InputError(
      'Cannot create output file. Use a new filename in an existing writable directory.',
    );
  }
}

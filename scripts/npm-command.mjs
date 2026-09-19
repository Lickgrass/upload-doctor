import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

// Windows command shims require a shell. Invoke npm's trusted JavaScript entry
// point with Node instead, so temporary paths remain literal argument values.
export function npmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', prefixArgs: [] };
  const candidates = [process.env.npm_execpath];
  for (const executable of new Set([process.execPath, realpathSync(process.execPath)])) {
    candidates.push(join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    if (
      typeof candidate !== 'string' ||
      !isAbsolute(candidate) ||
      basename(candidate) !== 'npm-cli.js'
    )
      continue;
    try {
      if (statSync(candidate).isFile()) {
        return { command: process.execPath, prefixArgs: [candidate] };
      }
    } catch {
      // Try the standard Node installation when npm_execpath is unavailable.
    }
  }
  throw new Error('Cannot locate npm-cli.js. Use a Node installation that includes npm.');
}

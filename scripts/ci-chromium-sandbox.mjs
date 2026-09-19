// Ephemeral GitHub-hosted Linux test runners only; never used by the package.
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const profileFile = '/etc/apparmor.d/upload-doctor-ci-chromium';
const restrictionFile = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const stateName = 'upload-doctor-ci-chromium-state.json';

export function buildProfile(cache, binaries) {
  // No AppArmor metacharacters, whitespace, traversal, variables, or globbing.
  const safe = (value) =>
    typeof value === 'string' &&
    value.startsWith('/') &&
    !/[^a-zA-Z0-9/_.-]/.test(value) &&
    posix.normalize(value) === value &&
    !value.endsWith('/');
  if (
    !safe(cache) ||
    !cache.endsWith('/.cache/ms-playwright') ||
    !Array.isArray(binaries) ||
    binaries.length !== 2
  ) {
    throw new Error('Unexpected Playwright cache or executable paths.');
  }
  const patterns = [
    /^chromium-[0-9]+\/chrome-linux64\/chrome$/,
    /^chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux64\/chrome-headless-shell$/,
  ];
  for (const [index, binary] of binaries.entries()) {
    if (
      !safe(binary) ||
      !binary.startsWith(`${cache}/`) ||
      !patterns[index].test(binary.slice(cache.length + 1))
    ) {
      throw new Error('Unexpected Playwright cache or executable paths.');
    }
  }
  return `# Temporary upload-doctor CI namespace permission; exact installed binaries only.\nabi <abi/4.0>,\ninclude <tunables/global>\n\n${binaries.map((binary, index) => `profile upload-doctor-ci-chromium-${index} "${binary}" flags=(unconfined) {\n  userns,\n}\n`).join('\n')}`;
}

function runner() {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.getuid?.() === 0 ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw new Error('This helper requires a nonroot GitHub-hosted Linux x64 runner.');
  const temporary = process.env.RUNNER_TEMP;
  if (
    !temporary ||
    !temporary.startsWith('/') ||
    realpathSync(temporary) !== temporary ||
    !lstatSync(temporary).isDirectory()
  ) {
    throw new Error('Unexpected runner temporary directory.');
  }
  return {
    temporary,
    stateFile: join(temporary, stateName),
    run: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    cache: join(homedir(), '.cache/ms-playwright'),
  };
}

function restriction() {
  const value = readFileSync(restrictionFile, 'utf8').trim();
  if (value !== '1')
    throw new Error('Expected the global AppArmor user namespace restriction to remain enabled.');
  return value;
}

function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function readOwned(path, uid, mode) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== mode ||
      stat.nlink !== 1 ||
      stat.size > 16384
    ) {
      throw new Error('Refusing an unexpected CI profile or state file.');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function privileged(...args) {
  // No shell. All privileged destinations and operations are fixed here.
  execFileSync('/usr/bin/sudo', ['-n', ...args], { stdio: 'inherit', timeout: 30000 });
}

async function setup(context) {
  if (!absent(profileFile) || !absent(context.stateFile))
    throw new Error('Refusing to replace an existing CI AppArmor profile or state.');
  const baseline = restriction();
  if (realpathSync(context.cache) !== context.cache)
    throw new Error('Playwright cache must be canonical.');
  const { chromium } = await import('playwright');
  const require = createRequire(import.meta.url);
  const registry = JSON.parse(
    readFileSync(
      join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'),
      'utf8',
    ),
  );
  const revision = registry.browsers.find(
    (browser) => browser.name === 'chromium-headless-shell',
  )?.revision;
  if (typeof revision !== 'string' || !/^[0-9]+$/.test(revision))
    throw new Error('Unexpected Chromium headless shell revision.');
  const binaries = [
    chromium.executablePath(),
    join(
      context.cache,
      `chromium_headless_shell-${revision}`,
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    ),
  ];
  const profile = buildProfile(context.cache, binaries);
  for (const binary of binaries) {
    const stat = lstatSync(binary);
    if (
      realpathSync(binary) !== binary ||
      !stat.isFile() ||
      (stat.mode & 0o111) === 0 ||
      ![0, process.getuid()].includes(stat.uid)
    ) {
      throw new Error('Expected canonical installed Chromium executables.');
    }
  }
  // Persist before the first privileged action so always-cleanup can recover a failed setup.
  writeFileSync(
    context.stateFile,
    JSON.stringify({ version: 1, run: context.run, baseline, binaries }),
    { flag: 'wx', mode: 0o600 },
  );
  const staging = mkdtempSync(join(context.temporary, 'upload-doctor-apparmor-'));
  try {
    const source = join(staging, 'profile');
    writeFileSync(source, profile, { flag: 'wx', mode: 0o600 });
    privileged('/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', source, profileFile);
    if (readOwned(profileFile, 0, 0o644) !== profile)
      throw new Error('Installed AppArmor profile differs from the validated profile.');
    privileged('/sbin/apparmor_parser', '-r', profileFile);
    if (restriction() !== baseline) throw new Error('Global AppArmor restriction changed.');
    for (const executablePath of binaries) {
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: 30000,
        args: ['--enable-automation'],
      });
      try {
        const session = await browser.newBrowserCDPSession();
        const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
        if (args.includes('--no-sandbox'))
          throw new Error('The CI sandbox probe unexpectedly disabled the sandbox.');
        const page = await browser.newPage();
        await page.goto('about:blank');
      } finally {
        await browser.close();
      }
    }
    if (restriction() !== baseline) throw new Error('Global AppArmor restriction changed.');
    console.log(
      'Both installed Chromium binaries launched with their sandbox enabled; global AppArmor restriction remains 1.',
    );
  } catch (error) {
    try {
      cleanup(context);
    } catch (cleanupError) {
      console.error(`CI AppArmor cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function cleanup(context) {
  if (absent(context.stateFile)) {
    if (!absent(profileFile))
      throw new Error('Refusing an existing CI AppArmor profile without its matching run state.');
    console.log('No temporary upload-doctor AppArmor profile to remove.');
    return;
  }
  const state = JSON.parse(readOwned(context.stateFile, process.getuid(), 0o600));
  if (state.version !== 1 || state.run !== context.run || state.baseline !== '1')
    throw new Error('Refusing mismatched CI AppArmor state.');
  const profile = buildProfile(context.cache, state.binaries);
  if (!absent(profileFile)) {
    if (readOwned(profileFile, 0, 0o644) !== profile)
      throw new Error('Refusing to remove a changed CI AppArmor profile.');
    privileged('/sbin/apparmor_parser', '-R', profileFile);
    privileged('/usr/bin/rm', '--', profileFile);
  }
  if (restriction() !== state.baseline) throw new Error('Global AppArmor restriction changed.');
  rmSync(context.stateFile);
  console.log('Removed the temporary Chromium AppArmor profiles; global restriction remains 1.');
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!['setup', 'cleanup'].includes(action) || rest.length)
    throw new Error('Usage: node scripts/ci-chromium-sandbox.mjs setup|cleanup');
  const context = runner();
  if (action === 'setup') await setup(context);
  else cleanup(context);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

# Contributing

Focused fixes, reproducible failure cases and documentation improvements are
welcome. Read [SECURITY.md](SECURITY.md) before reporting sensitive problems and
follow our [code of conduct](CODE_OF_CONDUCT.md).

## Local checks

Use Node.js 22.14 or newer and npm. Node 24 is the development default. CI
includes the minimum engine version, Node 22/24/26 on Linux and Node 24 on
Windows and macOS. Browser tests run against Chromium on Linux.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run check
npm audit --package-lock-only --audit-level=low
```

On Linux, Playwright may require system packages:
`npx --no-install playwright install --with-deps chromium`. Installing browser
binaries requires network access; the fixture tests themselves use local
services. Offline checks can run with `npm run typecheck`, `npm test` and
`npm run check:package` without launching a browser.

Keep the core free of runtime dependencies. Explain additions to the optional
browser path. Commit lockfile changes with dependency updates. Do not commit
generated `dist/`, `node_modules/`, package archives or real captures.

## Adding a diagnostic

Include a synthetic failing fixture, its repaired counterpart and a negative
control where the tool must decline a conclusion. Cite the relevant provider
documentation or standard. Record precisely what evidence the rule needs,
what the finding proves and which fresh check can verify the proposed repair.

Preserve the distinction between `unknown` and `fail`; absence of an API
response or HAR field is not proof of a missing configuration. Do not infer a
specific IAM cause from a generic 403. Do not turn a localhost result into a
claim about the production origin.

Keep stable rule IDs, CLI exit codes and report schemas compatible. Document
public changes in the README and changelog. Generated documentation examples
must match the exported API and command help.

## Pull requests

Explain the observed failure and resulting behavior, state which checks ran,
and identify untested provider assumptions. Include no signed URLs, tokens,
internal endpoints, customer data or raw captures. Use invented hosts and
synthetic requests. Contributions are licensed under [MIT](LICENSE).

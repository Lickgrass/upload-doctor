# Initial release-candidate verification

Recorded September 19, 2026. This is evidence about the supported v0.1 workflow,
not an enterprise certification, service-level commitment, or security guarantee.

## Completed locally

- Strict TypeScript checking and consistent formatting pass.
- 57 offline/configuration test groups pass, including secret canaries, malformed
  and oversized input, FIFO/symlink handling, partial captures, schema compatibility,
  CLI exits, safe sharing and comparison consistency.
- 15 tests use actual Chromium against local HTTP fixtures. These cover preflight
  rejection, opaque errors, real fail/fix comparisons, FormData, explicit assertions,
  changed origins/buckets, stale evidence, request limits and service-worker responses.
- The test suite passes on Node 22.14. Core/browser tests also pass on Node 24 and 26
  on macOS. Hosted operating-system coverage is recorded separately below.
- The package tarball installs into an isolated directory and its CLI and offline
  API work without Playwright or any other runtime dependency.
- `npm audit --package-lock-only --audit-level=low` reports zero vulnerabilities
  in the lockfile at the time of this check. Advisory status can change.
- The local browser demo produces a failed upload followed by a verified repair.
  Its storage implementation and signatures are deliberately synthetic.
- Separate code reviews covered diagnosis/comparison correctness and sensitive-data
  handling. Findings were repaired and regression tested: omitted evidence, wrong
  bucket identity, stale request times, unrelated contracts, missing report checks,
  nonregular files, redirect attribution and synthetic service-worker responses.
- The live-provider harness rejects missing opt-in or unsafe configuration before
  network work. Its syntax and signing configuration were checked offline.

## Remaining release evidence

- Hosted CI across Linux, Windows and macOS: consult the
  [CI runs for the candidate commit](https://github.com/Lickgrass/upload-doctor/actions/workflows/ci.yml).
  The workflow checks the minimum Node version, current 22/24/26 releases, installed
  package behavior, Chromium fixtures on Linux and dependency advisories. Its result
  is separate from the local checks above.
- Live AWS S3 and Cloudflare R2 integration: **not run**. No disposable provider
  targets were configured for this implementation session. Follow
  [live testing](live-testing.md) and record each provider's results separately.
- npm publication and provenance: **not performed**. The manual publishing workflow
  remains gated until live-provider verification and publisher configuration are complete.
- Independent user pilots and third-party security audit: not performed or implied.

## Repository controls

The public repository has secret scanning, push protection, dependency security
updates and private vulnerability reporting enabled. An `npm` deployment environment
requires maintainer approval and permits only `v*` tags. `ENABLE_NPM_PUBLISH` remains
unset, so pushing code cannot publish a package. npm publisher registration is still
required before a package release.

Reports are unsigned local observations. A user can edit JSON or supply false
assertions; the comparison engine checks consistency, not provenance or authenticity.
Keep original evidence private and review shared output before posting it.

Use the [release procedure](release.md) for the exact candidate commit and final
publishing gates. Passing fixture tests does not establish compatibility with every
provider configuration or verify an arbitrary production application.

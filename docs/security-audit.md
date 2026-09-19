# Security review — September 19, 2026

This review examined the Upload Doctor release candidate starting at commit
`711737392b705cb551c501d4e8318ca839b9935d`. Three parallel agent reviews and a
coordinating review examined the parser/report engine, browser collector,
CLI/filesystem boundaries, dependencies, package contents and release controls.
Suspected defects were reproduced with synthetic local inputs before fixes.
This is an internal engineering assessment, not an independent certification
or a guarantee that every vulnerability has been found.

## Verified findings and repairs

Severity describes this project's actual prerequisites and impact. None of
these reproductions established remote code execution or a compromise of a
cloud account. No npm release had been published during the review.

| ID     | Severity | Verified behavior before repair                                                                                                                                                                                                                                                    | Repair and regression evidence                                                                                                                                                                                                                                                            |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UD-001 | Medium   | A 292-byte HAR containing an unrelated request could stall hostname classification through excessive regular-expression backtracking. The child process exceeded a two-second deadline; ordinary host controls completed normally. Opening attacker-supplied evidence is required. | Replace the ambiguous hostname expression with bounded label parsing. Test supported endpoints and adversarial near-miss hostnames in a process with a deadline.                                                                                                                          |
| UD-002 | Medium   | With Playwright protocol debugging enabled, an actual Chromium upload printed a synthetic signed URL, authorization value and file body to stderr before report sanitization. The clean-environment control emitted none.                                                          | Reject observed `DEBUG`, `NODE_DEBUG` and `PWDEBUG` settings before browser import/launch or CDP attachment, and retain that rejection after the variables are removed. Replay the canary attack and test both API entry points and CLI. Caller-owned tracing remains outside this guard. |
| UD-003 | Low      | Imported report fields such as `source`, `provider` and finding status accepted JSON arrays through string coercion and could be re-exported with invalid enum types.                                                                                                              | Require primitive strings for every affected enum; reject malformed types in validation and sharing. No secret exposure or false verified comparison was demonstrated from this issue.                                                                                                    |
| UD-004 | Low      | A library consumer formatting a validated, edited report could emit terminal control sequences from narrative fields. The CLI's generated narratives did not expose this path.                                                                                                     | Escape control and directional-formatting characters per rendered line. Test OSC, CSI, carriage returns and bidi controls. This is terminal formatting, not HTML sanitization.                                                                                                            |
| UD-005 | Medium   | The release workflow could build an input tag different from its dispatch tag while npm provenance identified the dispatch commit. This required authorized maintainer dispatch and was latent while publishing was disabled.                                                      | Require dispatch tag, input tag and source commit to agree before validation, then recheck checkout identity before publishing. Execute the actual workflow guards against matching and mismatching local fixtures.                                                                       |
| UD-006 | Low      | The development-only live-provider harness used a second ambiguous hostname expression. A crafted endpoint in explicit local configuration exceeded a two-second deadline before opening a socket.                                                                                 | Use bounded service-host parsing and reject oversized endpoint input. Exercise hostile configuration with a deadline and valid endpoint controls without running cloud operations.                                                                                                        |

## What was exercised

- A deterministic 6,000-case HAR mutation corpus, malformed types, prototype
  keys, duplicate signing metadata and secret canaries in headers, URLs, paths,
  bodies, responses and imported report narratives. Inputs produced bounded
  diagnostic output or fixed errors. Sharing was checked separately from local
  metadata retention.
- Actual Chromium with local synthetic endpoints: preflight failure, misleading
  redirects, redirects outside the selected host, service-worker synthetic
  success, compressed/oversized/chunked error responses, capture limits and
  in-flight timeouts. Eleven additional adversarial scenarios passed after the
  fixes, alongside the existing browser suite.
- Offline CLI commands with instrumented network and process-creation sinks.
  A positive control proved the instrumentation could detect network use;
  hostile HAR URLs and embedded scripts did not reach those sinks through
  inspection, sharing or comparison.
- Deep unused JSON, terminal controls, bounded input reads, invalid UTF-8,
  regular-file enforcement, FIFO and symlink rejection, private output modes
  and concurrent exclusive writes. Thirty-two simultaneous output attempts
  produced one winner without clobbering the winning file.
- Git history secret scanning, dependency advisories, registry signatures and
  available attestations, lockfile integrity fields, runtime dependency tree,
  package allowlist and an isolated package install. Offline operation has no
  mandatory runtime dependencies; browser capture adds Playwright and Chromium.
- Workflow analysis and live read-only inspection of repository protections,
  Actions permissions, publishing environment, release tags and secret-scanning
  settings. Workflow command-injection and privilege boundaries were reviewed.
- Local Semgrep OSS 1.177.0 with 213 JavaScript/TypeScript and GitHub Actions
  rules from the official rule repository, pinned at
  `40b8c63f75dc7c22c8a77482d73bfb864b146f7e`. It scanned 14 implementation and
  workflow files with telemetry disabled. Six raw matches were investigated:
  UD-006 was reproduced and repaired; the remaining five were false positives
  checked against bounded inputs and actual code paths. Zizmor additionally
  checked workflow security and returned no findings after the fixes.

The mutation tests and browser attacks ran locally with synthetic data. They
were bounded fuzzing and attack simulations, not self-propagating worms. Source
and captures were not uploaded to a third-party scanning service.

## Supply-chain and repository results

At the time of the review, npm's advisory check returned no known dependency
vulnerabilities. npm verified 39 installed package signatures and 10 available
attestations. Gitleaks found no secrets in the two baseline commits. These are
time-bounded checks, not proof that dependencies contain no malicious behavior.
A development-dependency SBOM and scan results were retained with the local
audit evidence; the package itself was inspected separately.

Existing controls include read-only workflow tokens, disabled workflow approval
of pull requests, commit-pinned actions, private vulnerability reporting,
secret scanning and push protection, required CI checks, and immutable `v*`
release tags. During the review, repository policy was tightened to require
full commit pins and allow only `actions/checkout` and `actions/setup-node`.
See GitHub's [Actions permissions API](https://docs.github.com/en/rest/actions/permissions)
for the policy semantics. The settings were read back after the change.

## Remaining limits and release gates

- Live AWS S3 and Cloudflare R2 integration remains **unrun**. No disposable
  cloud targets or credentials were supplied. Local fixtures cannot establish
  live provider compatibility, IAM correctness, CORS configuration or cleanup
  behavior across production configurations.
- npm publishing remains disabled. Trusted-publisher registration and actual
  published provenance have not been verified. A safe guard test does not
  establish that a release was published successfully.
- The repository has one maintainer. Administrators can bypass main's review
  requirement, and the deployment reviewer may approve their own release.
  Organization policy does not require two-factor authentication; this does not
  establish whether the maintainer's account has it enabled. Independent human
  release approval and organization-wide identity policy remain governance work.
  Organization-wide settings were not changed by this repository audit.
- Use a currently patched Node release and browser. The package's minimum
  compatibility version is not a security recommendation. Host compromise,
  malicious runtime hooks and caller-enabled logging/tracing can bypass local
  confidentiality assumptions.
- Browser capture executes the chosen application and permits its normal
  network activity. It is not an isolation boundary for hostile websites.
  Offline APIs taking already-constructed JavaScript objects assume ordinary
  data objects; they are not a sandbox for hostile getters, proxies or code
  already executing in the same process.
- Reports are unsigned local observations. Consistency checks do not prove
  authenticity, uploaded-byte integrity or truthful caller assertions. Shared
  reports still reveal aggregate timing and diagnostic outcomes. Local output
  requires a directory and operating-system permissions controlled by the user.
- This review does not claim compliance certification, a service SLA, formal
  verification, exhaustive fuzzing, a third-party penetration test or coverage
  of a deployment that was not examined.

The maintained regressions are in `tests/security-*.test.mjs` and
`tests/live-config.test.mjs`. Run `npm run check`
and the advisory check before releasing. See [verification](verification.md)
for the final local and hosted test evidence, and [release](release.md) for the
publishing procedure.

## Follow-up review after PR #2

A user-supplied review identified gaps missed by the initial audit. The follow-up
started from merged commit `4833796fa6ad44c89d4a025edd1de8e5d55276e5` and reproduced
the browser launch and signal behavior rather than relying on launch defaults.

| Item                                         | Verified evidence and repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium: Chromium sandbox disabled by default | Actual process arguments contained `--no-sandbox`. Owned capture and the live harness now explicitly enable the sandbox, fail closed on unsupported platforms, and disable it only through a named insecure opt-out. Running-process tests confirm both policies. This adds browser containment; it does not make an untrusted application safe to browse.                                                                                                                                                                                                                  |
| Reliability: signals lost evidence           | Baseline SIGINT exited 130; SIGTERM lost completion evidence; SIGHUP failed to finish before the bounded test deadline. Playwright's competing signal handlers are now disabled. The CLI owns shutdown through finalization, output and cleanup. Actual subprocess tests send all three signals and confirm the requested report survives. Startup cancellation returns code 2. Queued completion events may still remain unknown.                                                                                                                                          |
| Release privilege separation                 | The earlier publish job installed development dependencies and rebuilt while it could mint an OIDC token. Validation now builds and retains the exact package it tests without OIDC. The publishing job downloads that archive by immutable artifact ID, checks source/run identity and SHA-256, then publishes with scripts disabled. It performs no checkout, install, build or repack. The pinned actions, Node/npm and GitHub infrastructure remain trusted components. A compromised build can still produce a malicious artifact; hashing is not a code-safety proof. |
| Low: stale local archive                     | The ignored root archive contained the earlier vulnerable hostname expression and lacked the browser debug guard. Its hash and contents were recorded privately, then that exact file was deleted. Package verification uses temporary directories and retains a candidate only in an explicitly requested new directory.                                                                                                                                                                                                                                                   |
| Package inventory                            | The earlier script checked required files and denied several sensitive path patterns; `package.json` supplied the broad directory allowlist. A separate reviewed manifest now requires the exact 35-file package set. Archive structure and bytes must match the built checkout before package execution; installed bytes and the retained archive are checked again.                                                                                                                                                                                                       |
| Output-pipe cleanup                          | Cross-review of the shutdown repair found that a direct EPIPE exit could interrupt browser cleanup. Stdout now uses awaited write callbacks and preserves diagnostic status; an actual Chromium test closes the output pipe and verifies both saved output and completed browser closure.                                                                                                                                                                                                                                                                                   |

The sandbox default is explicitly documented by
[Playwright's launch API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox).
The locked Playwright version was also checked directly: its automation flags
include basic password storage, a mock keychain and disabled HTTPS upgrades.
These remaining differences, caller-owned browser policy and update obligations
are documented in [privacy](privacy.md#browser-sessions). No claim that the
bundled browser matches the current stable Chrome patch level is made.

The CLI help now explains Windows ACL/symlink limits and hostname selection
across all ports. Broad S3 hostname recognition, including website-style names,
selects observations only; it does not establish endpoint compatibility or
authorize network access. The formatter's remaining invisible Unicode characters
are a display limitation for imported library narratives, not a raw-input CLI
execution path.

Repeated startup-abort tests also exposed a DevTools cleanup race: 12 of 25
baseline runs exited before an unresolved detach promise settled. Detachment now
finishes on page closure or a referenced, bounded deadline. All 25 repeated runs
then returned the fixed startup-interruption error, and a deterministic stalled
detach test covers the deadline. The CLI initializes its exit status to failure
until the operation settles, so an unexpectedly empty event loop cannot imply
success.

Package subprocesses now pass arguments directly rather than invoking
`npm.cmd` through a shell on Windows. A package regression uses spaces and `&`
in its checkout, temporary directory and archive paths, including direct
invocation without npm's environment hint. Hosted Windows CI verifies the actual
Windows path; no capture-to-shell exploit was asserted from a macOS-only test.

Administrator bypass, solo-maintainer deployment approval and release-tag
creation policy remain the disclosed governance limits. They were not silently
changed or represented as independent human review. Actions SHA pinning remains
required; the allowlist now also includes the pinned upload/download artifact
actions. Live cloud behavior and real npm trusted publishing remain untested.

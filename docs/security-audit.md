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

The maintained regressions are in `tests/security-*.test.mjs`. Run `npm run check`
and the advisory check before releasing. See [verification](verification.md)
for the final local and hosted test evidence, and [release](release.md) for the
publishing procedure.

# @lickgrass/upload-doctor

Find where your S3 or R2 browser upload breaks, then compare a fresh run after
the repair. Upload Doctor examines evidence from your existing application:
the signed request, browser CORS behavior, storage response and any explicit
application success assertion. Missing evidence stays **unknown**.

Standalone, MIT licensed, local processing, no account or telemetry. Offline
analysis has no runtime dependencies. Browser capture uses optional Playwright.
Node.js 22.14 or newer; ESM and TypeScript declarations.

## Try it from source

This checkout is the release candidate. See [release readiness](docs/release.md)
for checks that must be recorded before publication; the commands below do not
assume a package already exists on npm.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js inspect failed-upload.har --out before.json
```

HAR files can contain signed URLs, cookies, tokens, private names and file
contents. Keep the input local. Upload Doctor does not replay imported requests.
For public reports use `share`, then review the output:

```sh
node dist/cli.js share before.json --out share.json
```

An illustrative diagnosis, when the captured provider response supports it:

```text
Storage rejected the upload: ExpiredRequest
Confirmed: the provider reported that the signed URL expired.
Obtain a fresh URL immediately before uploading, then repeat the same flow.
```

A browser can show a CORS error for an underlying storage failure. For example,
[R2 documents](https://developers.cloudflare.com/r2/buckets/cors/) that an
expired presigned URL returns an error without CORS headers. When that response
is unavailable, the tool cannot confirm this cause merely from a CORS message.

## Capture the real browser flow

Install Chromium once, using the Playwright version in the lockfile:

```sh
npx --no-install playwright install chromium
node dist/cli.js capture https://staging.example.com/upload --duration 30 --storage-host upload-doctor-demo.s3.us-east-1.amazonaws.com --out before.json
```

For a self-contained example before connecting your application, run
`node examples/local-demo.mjs`. It demonstrates a failing upload, a correction
and a verified comparison using local servers and synthetic signatures. It
makes no AWS/R2 calls and does not establish live-provider compatibility.

Capture opens a separate, headed Chromium session. Sign in and use the application's
uploader normally. Choose a staging application and a small synthetic file. The
application still performs its normal network operations, including uploads;
Upload Doctor observes them. It does not generate cloud credentials, change
bucket configuration or replay a PUT on your behalf. The browser session starts
without your usual profile, cookies or extensions.

Chromium's sandbox is enabled explicitly. Capture fails if the platform cannot
support it; there is no automatic fallback. `--insecure-no-sandbox` is an
explicit exception for a trusted isolated environment, not a normal setup step.
See [browser privacy and launch policy](docs/privacy.md#browser-sessions).
Once capture starts, Ctrl-C finalizes and saves the report before closing the
browser. Interrupting startup exits with code 2.

Observation is limited to selected storage requests and their preflights. It does
not capture the application's signing endpoint response or inspect server-side
signer code. Supply signer expectations in a contract when needed. A failure
before the browser contacts storage can leave no observed upload and remains
inconclusive.

Apply the relevant repair in your application or storage configuration, capture
again from the same application origin, and compare:

```sh
node dist/cli.js compare before.json after.json --json
```

The comparison distinguishes improved diagnostics from a verified repair. A
fresh, comparable browser run and explicit application success evidence are
needed for a verified result. The CLI does not infer an application assertion;
use the programmatic collector in a Playwright test to record one. CLI captures
can still establish improvements. An offline HAR cannot establish everything
the browser or application observed. See [evidence and coverage](docs/diagnostics.md).

## Declare what the application expects

A contract makes expectations explicit when they cannot be inferred from a
capture. It is optional. Use exact storage hosts, without a scheme or path:

```json
{
  "version": 1,
  "id": "avatar-upload",
  "storageHosts": ["upload-doctor-demo.s3.us-east-1.amazonaws.com"],
  "provider": "s3",
  "method": "PUT",
  "body": "raw",
  "contentType": "image/png",
  "requiredResponseHeaders": ["etag"]
}
```

```sh
node dist/cli.js inspect failed-upload.har --contract upload-contract.json --request upload-1 --json
```

Only require response headers your application actually reads. An ETag is not a
universal checksum. A presigned URL reveals signed header names, not the original
expected values; supply those expectations from your signer when needed.

Known S3 and R2 endpoints determine bucket addressing automatically. For a custom
storage host, declare `"pathStyle": true` if the first URL path segment is the
bucket, or `"pathStyle": false` if the host identifies the destination. Without
that declaration the tool does not guess the destination, and comparison remains
unknown. `--storage-host` alone selects traffic; it cannot declare custom-host
bucket addressing. Use `--contract` instead for this case.

Host selection compares hostnames, not ports: `localhost` selects matching
traffic on every local port. This is an observation filter, not a network access
control. Reports retain the full origin, including port, for comparison.

## Commands

| Command                              | Purpose                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `inspect <capture.har>`              | Analyze a local HAR without contacting the bucket.     |
| `capture <application-url>`          | Observe the application's upload in Chromium.          |
| `compare <before.json> <after.json>` | Compare local reports and explain verification limits. |
| `share <report.json>`                | Produce a report with identifying metadata replaced.   |

`--json` selects machine-readable stdout; `--out <path>` writes JSON to a new
file while retaining normal stdout formatting. Output files are created
exclusively with mode `0600` on supporting filesystems: existing files and
symlinks are not overwritten. `share` always emits JSON. `--contract <path>`
supplies upload expectations. `--request <id>` selects one observed upload
during inspection. Capture accepts `--duration <seconds>` (30 by default,
maximum 600), `--headless` and repeatable `--storage-host <host>`. Run
`node dist/cli.js --help` for the complete interface.

| Exit code | Meaning                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`       | Inspection found no failing checks, or comparison verified the repair. Inspection exit 0 alone is not proof of application success.        |
| `1`       | A diagnostic failed, or comparison found the repair not fixed.                                                                             |
| `2`       | Invocation, input, I/O or browser execution failed.                                                                                        |
| `3`       | Coverage is incomplete (no uploads, truncation or unsupported flow); comparison is improved/unknown; or `--strict` found an unknown check. |

Use `--strict` with inspection or capture when unknown checks must also prevent
exit 0. A detected failure takes precedence over incomplete coverage. Some
properties, including signing credential validity and stored-byte integrity,
cannot be fully established from a capture, so strict mode can reject an
otherwise successful upload.

Local reports are intended for diagnosis and comparison. They retain identifying
origin, endpoint, bucket/destination and per-request timing metadata, with
credential material excluded. Destination and request time help establish that
a later run tested the same bucket. Shared reports deliberately lose that
correlation detail and cannot establish a verified before/after repair.

## Coverage

| Flow or check                                                | v0.1 boundary                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| AWS S3 / Cloudflare R2 presigned PUT                         | Supported flow, subject to evidence availability.                                          |
| CORS, expiration, signed headers, provider errors, redirects | Findings require relevant captured evidence; missing data is unknown.                      |
| FormData sent to a raw PUT                                   | Requires an expected raw-body contract; a header alone is not byte-integrity proof.        |
| Browser-readable response headers                            | Must be required by the application and supported by response/CORS evidence.               |
| Application completion                                       | Requires an explicit assertion, not just HTTP 200.                                         |
| Multipart, presigned POST, resumable protocols               | Unsupported; no complete flow verdict.                                                     |
| Generic `AccessDenied`                                       | Reported without inventing the policy responsible.                                         |
| Service-worker-supplied response                             | Storage acceptance remains unknown; the response may have been synthesized in the browser. |
| Object byte verification, IAM simulation, bucket edits       | Not performed.                                                                             |

The four finding states are `pass`, `fail`, `unknown` and `unsupported`.
Confidence is separate: `confirmed`, `likely` or `unknown`. A pass applies to
the named check and captured run, not to the whole bucket or every user.

## Why this exists

[Spoold](https://spoold.com/tools/web/s3-r2-cors) already compares CORS policies
with request details and generates corrections.
[DecodeLens](https://decodelens.com/en/tools/aws-sigv4-presigned-url-debugger/)
already explains presigned requests and signature structure. Both document
that they do not replay live requests. DevTools and curl can expose the raw
evidence; broad S3 compatibility suites serve storage implementations.

Upload Doctor connects that evidence to the application's upload, a specific
repair and a fresh comparison. It works alongside existing upload libraries and
storage providers. See [automation](docs/automation.md) for retaining checks
after an incident, and [privacy](docs/privacy.md) before sharing evidence.

## Development

The offline library exposes the same inspection and reporting functions:

```js
import { readFile } from 'node:fs/promises';
import { inspectHar, shareReport, reportExitCode } from '@lickgrass/upload-doctor';

const har = JSON.parse(await readFile('failed-upload.har', 'utf8'));
const report = inspectHar(har);
console.log(JSON.stringify(shareReport(report), null, 2));
process.exitCode = reportExitCode(report);
```

`inspectHar(har, { contract, requestId })` accepts optional expectations and
selection. `createReport` accepts normalized evidence; `compareReports` compares
local reports. The optional browser entry point exports `attachCapture` for an
existing Chromium page and `startCapture` for a new session. See
[automation](docs/automation.md), the [rule catalog](docs/rules.md) and the
exported TypeScript declarations for their boundaries.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run check
npm audit --package-lock-only --audit-level=low
```

The browser tests use local fixtures. Passing them does not establish that live
AWS S3 or R2 integration has been tested. The [release checklist](docs/release.md)
separates local verification, CI and live-provider checks.

## Built by Lickgrass

Built by [Lickgrass](https://lickgrass.com). This is an independent open source
tool; it does not require a Lickgrass deployment, account or private platform
code. Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).
For vulnerabilities use [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).

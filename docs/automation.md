# Retain a check after fixing an upload

A useful regression test obtains a fresh signed URL through the application's
normal code, runs the real browser upload and asserts the outcome the
application depends on. Saving one presigned URL in a test fixture does not
work: it expires and may authorize writes to a real object.

## Test contract

Use a staging application or local fixture, a small synthetic file and a unique
disposable object key. Keep signing code and client headers identical to the
application path being checked. Declare required response headers only when the
application reads them. Assert a meaningful completion condition; storage HTTP
200 alone is insufficient.

Keep the application origin stable between baseline and repaired runs. A test
from localhost tests localhost, even if the same bucket serves production. Do
not bypass browser CORS checks or rewrite the signed URL to make a test pass.
Keep the destination bucket stable too. Known S3/R2 addressing is recognized;
custom hosts require the contract's `pathStyle` declaration. Per-request timing
and destination metadata remain in private reports for this comparison.

The optional browser library entry point is
`@lickgrass/upload-doctor/browser`. Its exported TypeScript declarations are the
source of truth for capture hooks and assertion options. After a correlated
upload completes, record the application's assertion with
`collector.markApplicationSuccess('upload-1', 'avatar-visible', true)` (or
`false` when it failed). The assertion ID must represent the same check across
runs. Do not set it merely because the storage request returned HTTP 200. CLI
capture has no automatic application assertion, so a programmatic collector is
needed for this stronger verification. Offline library consumers should import
`@lickgrass/upload-doctor` without loading Playwright.

When the application must read a response header, have the test observe that
read in the page's JavaScript context and record the result after the correlated
accepted upload completes:

```js
collector.markResponseHeaderAccess('upload-1', { etag: true });
```

The boolean must come from an assertion that actually ran; use `false` when the
application could not read the required header. Do not derive it from DevTools
or Playwright network-response headers, which can expose values inaccessible to
page JavaScript. Use the actual upload ID returned by `collector.requests()`
and finish recording assertions before calling `finish()`.

Observation covers storage traffic and preflights, not the signer's HTTP
response. The application test drives the signer normally; Upload Doctor does
not independently probe it or generate replacement signed requests.

In a synthetic fetch fixture, consume the response (for example,
`await response.arrayBuffer()`) before declaring the request complete. A fixture
that leaves it unread can produce a Chromium aborted-request event even after
JavaScript sees an HTTP success. Capture retains uncertainty in that case rather
than manufacturing completion.

## Reports and exit status

When creating a browser for `attachCapture`, explicitly pass
`chromiumSandbox: true` to `chromium.launch`. The collector cannot enable it
after launch. If your runner owns graceful shutdown, also pass
`handleSIGINT: false`, `handleSIGTERM: false` and `handleSIGHUP: false`, then
finalize the collector and close the browser in your own shutdown path.
`startCapture` applies that launch policy for its owned browser; its caller must
still close the returned session. See [browser policy](privacy.md#browser-sessions)
for the explicit sandbox exception and remaining automation-browser differences.

Use `--json --out <path>` when collecting a local report. Run the CLI with
`--strict` when incomplete or unsupported coverage should prevent a passing CI
step. Preserve the command's exit status; a report existing on disk does not mean
that the upload passed. `compare` reports whether the repair was verified,
improved, not fixed or unknown.

Keep local reports private. If a report is needed outside the environment, run
`share`, review the result and apply your organization's retention policy.
Shared reports do not retain the evidence identity needed to certify a before/
after comparison.

## Network and cleanup

Repository tests use synthetic local servers. A live-provider check is separate
and must run in an environment authorized to write disposable objects. The
operator owns the fixture's cleanup policy; Upload Doctor does not acquire admin
credentials, remove objects or abort multipart uploads automatically.

Do not expose storage credentials to untrusted pull requests. External account
outages, expired credentials and incomplete captures should surface explicitly,
not be converted into empty passing reports.

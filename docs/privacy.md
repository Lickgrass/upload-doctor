# Privacy and evidence handling

Offline analysis runs locally. No account, telemetry service or cloud secret
access key is needed. Browser capture contacts the application and services that
the application itself uses; it is not a network-free operation.

## Three kinds of data

| Data                                | Handling                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original HAR / browser observations | Private input. May contain reusable bearer URLs, tokens, cookies, filenames, request bodies and responses. Never attach it to a public issue.                                                                                    |
| Local report                        | Selected diagnostic output for the operator. Credential material is excluded, but origin, endpoint, bucket/destination, contract/assertion IDs and per-request time are private metadata. Keep local reports private by default. |
| Shared report                       | Generated with `share`, replacing identifying profile metadata with opaque labels. Review it before sharing; diagnostic context may still be sensitive in your organization.                                                     |

Shared output retains aggregate capture time, rule outcomes and counts; it is
not designed to hide the fact that a capture occurred or which diagnostic failed.

Use the report exporter rather than manually removing just `X-Amz-Signature`.
Presigned requests may carry session tokens and credential identifiers; private
names can also appear in paths, errors and metadata. Chrome's sanitized HAR is
not a guarantee that a capture contains no signed URL or confidential content.

```sh
node dist/cli.js inspect failed-upload.har --out local-report.json
node dist/cli.js share local-report.json --out shared-report.json
```

Output files should stay in a directory you control. `--out` creates a new file
exclusively, requesting mode `0600`; it refuses an existing file or symlink.
Permissions depend on your operating system and filesystem, and do not replace
access controls or encryption. The tool does not encrypt reports or certify
them for a compliance regime.
In particular, Windows does not provide the same input symlink rejection and
POSIX mode guarantees. Use input paths you trust and a directory with restrictive
Windows ACLs; the CLI does not create or audit those ACLs for you.

## Browser sessions

Start a fresh process with `DEBUG`, `NODE_DEBUG` and `PWDEBUG` unset before
importing either Playwright or Upload Doctor. The browser entry points refuse
these variables when observed, even if they are subsequently removed. Upstream
protocol logs can expose signed URLs, authorization headers and complete file
bodies before this tool's sanitization runs.

When attaching to a caller-owned browser, disable custom Playwright loggers,
protocol logging, tracing and HAR recording as well. A logger initialized before
this module was imported, or enabled programmatically afterward, cannot be
detected reliably by an environment check. This restriction also applies to
test runners and wrappers. The collector does not sanitize another component's
logs, crash dumps, process arguments or browser profiles.

Capture uses an isolated session, not your daily browser profile. Sign in only
to the application you intend to inspect. Prefer staging, synthetic accounts and
small synthetic files. The application is responsible for its normal upload,
side effects and cleanup. Capture is not permission to test somebody else's
service.

Owned capture enables Chromium's sandbox explicitly. If the operating system
cannot support it, startup fails with a fixed error rather than retrying with
less isolation. Only in a trusted isolated environment, use
`--insecure-no-sandbox` or the library's `insecureNoSandbox: true` option as an
explicit exception. `attachCapture` cannot retrofit a sandbox into a browser
that is already running: callers must launch it with `chromiumSandbox: true`.

Some Linux systems restrict the user namespaces Chromium needs. An administrator
must configure suitable sandbox support; see Chromium's
[AppArmor guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
The CLI never changes host security policy. Our disposable Ubuntu CI runners
use a narrowly scoped, temporary AppArmor profile for the exact installed browser
executables. This permits those binaries to create user namespaces while keeping
the system-wide restriction enabled. Anyone able to replace an allowed binary
could inherit that permission, so this CI setup is not a general workstation
installation procedure.

Playwright's automation browser differs from a normal browsing profile. The
locked version supplies flags including `--password-store=basic`,
`--use-mock-keychain`, and disabled `HttpsUpgrades`. Do not save passwords or use
this session as your everyday browser; use explicit HTTPS URLs for real
applications. Bundled Chromium follows the installed Playwright version and
does not inherit your system Chrome updates. Update and retest Playwright and
its browser together. Enabling the sandbox does not restore all normal browser
security preferences or prevent the page's authorized network activity.

The CLI owns SIGINT, SIGTERM and SIGHUP while capturing. After capture has
started, these signals finalize the report, write the requested output and
close the browser; interruption during startup returns error code 2. The
programmatic `startCapture` API installs no process signal handlers. Its caller
must call `finish()` and `close()` during shutdown; an AbortSignal finalizes an
active collector but the caller still owns browser closure.
Finalization retains evidence already observed; an in-flight request or queued
browser completion event can still leave its outcome unknown. Closing a stdout
pipe does not skip cleanup or replace the diagnostic exit status.

The collector observes selected storage requests and preflights. It does not
save the signing endpoint response, arbitrary application traffic or a complete
browser trace. Signing expectations and application assertions must be supplied
explicitly. The page still contacts those services as part of its normal flow.

Do not persist raw traces, screenshots, HAR exports or browser profiles in CI
artifacts. This project's workflows run synthetic fixtures and do not upload
capture artifacts. Do not add real provider tokens to pull-request workflows.

## Public bug reports

Send tool and runtime versions, the stable rule ID, expected versus actual
behavior and a synthetic reproduction. If needed, attach only a reviewed shared
report. For suspected secret leakage or a sanitizer bypass, follow
[SECURITY.md](../SECURITY.md) privately.

# Security policy

## Reporting

Use GitHub's **Security → Report a vulnerability** for this repository when
enabled. Otherwise open an issue saying only that you need a private reporting
channel; a maintainer can arrange it. Do not disclose the vulnerability or
attach a real HAR, presigned URL, authentication token or customer file publicly.

Include the affected version and runtime, impact and reproduction using
synthetic data. Security fixes target the latest published version. Older
versions have no separate backport policy. No response-time or support SLA is
promised.

## Boundaries

- Offline inspection parses user-supplied files. It never evaluates captured
  JavaScript, executes copied shell commands or replays HTTP requests.
- Browser capture visits the application URL chosen by the operator in a
  separate browser session. That page and its uploader can contact services and
  write objects as they normally would. Capture is not a sandbox for an
  untrusted application. Use a patched runtime and browser.
- Start capture in a fresh process with `DEBUG`, `NODE_DEBUG` and `PWDEBUG`
  unset. Capture rejects these diagnostic environments because upstream logs
  can contain complete signed URLs, authorization headers and file bytes.
  Callers of the browser API must also disable their own loggers and traces
  before importing Playwright. The collector cannot control external logging.
- The tool does not need cloud secret access keys to observe an existing
  uploader. Captures may still contain bearer URLs, authentication data,
  sensitive paths and response bodies. Treat inputs as secrets.
- Local reports can retain identifying diagnostic metadata. Use the `share`
  command and inspect its output before distributing a report. Sanitization
  reduces exposure; it does not establish that organizational policy permits
  sharing a report.
- Do not run real customer captures in public CI. Repository tests must use
  synthetic inputs. Do not upload raw browser traces as workflow artifacts.
- A likely cause is not proof. A pass is limited to the documented check. The
  tool does not authorize policy changes, certify a bucket or verify all
  uploaded bytes.
- Contract files, captured responses and reports are untrusted data. Downstream
  tools must escape output for their display context and never execute it.

See [privacy and evidence handling](docs/privacy.md) and
[diagnostic coverage](docs/diagnostics.md). The
[September 2026 security review](docs/security-audit.md) records verified fixes,
adversarial tests and remaining assurance limits.

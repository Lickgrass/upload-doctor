# Changelog

## 0.1.0 — Unreleased

- Follow-up hardening enables Chromium's sandbox by default, adds explicit opt-outs,
  preserves CLI reports and browser cleanup across signals and closed output pipes,
  publishes only the tested archive from a separate job, and verifies an exact
  package file manifest. A stale local archive was removed before publication.

- Local HAR inspection for application uploads to AWS S3 and Cloudflare R2.
- Evidence-based findings with separate status, confidence and coverage limits.
- Optional Chromium capture and before/after report comparison.
- Explicit upload contracts and a separate shareable report format.
- Standalone CLI and ESM library with TypeScript declarations.
- Synthetic offline/browser tests, packaged-install checks and manual release
  workflow. Live-provider release validation is tracked separately.
- Security review: bounded provider hostname parsing, browser diagnostic logging
  guards, strict imported-report enum validation, terminal control escaping and
  release tag/commit identity checks, including bounded endpoint parsing in the
  development live-test harness. See `docs/security-audit.md` for evidence
  and scope limits.

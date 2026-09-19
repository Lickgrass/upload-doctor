# Release procedure and readiness

This file describes release controls. Their presence does not mean that a
release has been published, GitHub settings have been configured or live cloud
tests have passed. Record the evidence for the exact commit being released.

The initial implementation's completed and pending checks are recorded in
[verification evidence](verification.md).

## Required evidence

- [ ] Reviewed source, dependency lockfile, package contents and changelog.
- [ ] Offline tests, type checks and packaged-install checks passed on the CI
      matrix: Node 22.14 minimum plus 22/24/26 on Linux and 24 on Windows/macOS.
- [ ] Chromium fixture tests passed on Linux.
- [ ] `npm audit --package-lock-only --audit-level=low` passed or any advisory
      received an explicitly documented disposition before release.
- [ ] Sensitive-data handling received an independent review and adversarial
      tests cover reports, errors and comparison output.
- [ ] Diagnostic correctness received a separate review, including negative
      controls and unknown/unsupported behavior.
- [ ] **Live AWS S3 verification:** run the supported browser PUT path against
      disposable objects. Record region, runtime, check outcomes, failing/fixed
      scenarios and cleanup without recording credentials or signed URLs.
- [ ] **Live Cloudflare R2 verification:** record equivalent evidence, including
      CORS and expiration behavior when provider responses are observable.
- [ ] Package version, immutable `vX.Y.Z` tag and reviewed commit match.
- [ ] Repository and npm ownership, access, workflow permissions and publication
      settings are configured and reviewed.

Live S3/R2 checks are not implied by local browser fixture success. Cross-platform
CI is not implied by a local macOS run. Until evidence is recorded, these gates
remain pending. There is no certification, availability commitment or enterprise
support SLA attached to v0.1.

## GitHub settings

Protect the default branch and release tags. Require review and the CI jobs
appropriate to the release. Enable private vulnerability reporting. Set up an
`npm` deployment environment with required reviewers and appropriate tag
restrictions. Review both the tag and workflow revision before dispatch.

The manual workflow `.github/workflows/release.yml` is disabled unless the
repository variable `ENABLE_NPM_PUBLISH` is exactly `true`. Leave that variable
unset until initial validation and publishing configuration are complete.
Pushing a branch or tag does not publish. The workflow only runs when explicitly
dispatched for a stable `vX.Y.Z` release tag, checks tag/version alignment and
reruns validation before publication.

## npm trusted publisher

Configure a trusted publisher for the exact package and repository, workflow
filename `release.yml` and environment `npm`. Permit direct `npm publish` if
using this workflow; a stage-only publisher needs a different publishing step.
The workflow uses GitHub-hosted Linux, Node 24 and checks that npm supports OIDC.
No long-lived npm token is expected. Establish package ownership and initial
publication separately if required before a trusted publisher can be assigned.
Do not silently replace OIDC with a stored token when setup fails.

The package must be public and its `repository.url` must match the public
repository for the intended provenance. Verify the resulting npm version,
integrity and provenance after publishing. Provenance links an artifact to its
build; it does not certify the code's security.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the
current configuration and CLI requirements, and
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/) for
verification. Workflow action references are pinned to verified full commit
SHAs; dependency updates should preserve this practice.

## Local rehearsal

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run check
npm audit --package-lock-only --audit-level=low
npm pack --dry-run --ignore-scripts
```

Review the file list and package-install smoke results. Do not include real
captures, generated reports, browser profiles or credentials. These commands
do not publish a package.

## Dispatch and recovery

After all gates pass, an authorized maintainer creates the version tag on the
reviewed default-branch commit and manually dispatches **Release** with that
tag. Approve the `npm` environment only after checking the exact commit and
validation results. No workflow is authorized merely by having been added to
the repository.

If publication fails ambiguously, inspect the npm registry before retrying.
Published versions are immutable; never overwrite or reuse a version. For a
faulty release, stop subsequent releases, assess impact, document the correction
and publish a new version through the same checks. Follow the security policy
for confidential issues; deprecate affected versions when appropriate.

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
- [ ] The exact tested package archive, its SHA-256 and immutable Actions artifact
      ID are recorded for the release run; publication consumes those same bytes.
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
reruns validation before publication. The workflow dispatch ref must be that same
tag. Validation requires the checked-out source to match the workflow's
`GITHUB_SHA`; publication requires the validated source identity and run ID to
match that same workflow run.

## Build and publication boundary

The validation job has read-only repository access and no OIDC permission. It
installs the locked development dependencies with lifecycle scripts disabled,
builds and tests the project, then runs the package checker with `--out-dir`.
That checker retains the same archive it inspected and installed for its isolated
consumer tests. The workflow records its SHA-256 and uploads only that archive
under the fixed artifact name `upload-doctor-release`, with overwrite disabled.
The artifact ID, filename, digest, source commit and run ID become job outputs.

The separate `npm` environment approval gates publication. This job has OIDC
permission, but does not check out source, install dependencies, build, pack, or
execute application/package-checker code. Pinned official actions set up Node and
download the immutable artifact ID from the current run. Inline checks using only
Node built-ins reject changed identity, extra files, nonregular files, unexpected
names/sizes, and any archive SHA-256 mismatch. npm then publishes that exact
archive with `--ignore-scripts` and provenance. Both the artifact action's outer
digest and the package archive's own digest must match.

This boundary keeps development tools and project code out of the job that can
request an npm publishing identity. The reviewed workflow, GitHub runner/actions,
Node/npm distribution, and artifact service remain trusted infrastructure. An
archive passing its tests is not proof that its implementation is harmless.

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
release_work="$(mktemp -d)"
node scripts/check-package.mjs --out-dir "$release_work/package"
```

Review the file list and package-install smoke results. Do not include real
captures, generated reports, browser profiles or credentials. These commands
do not publish a package. The output directory must be new; the retained archive
is accompanied by private local verification metadata, which is not uploaded as
the release artifact.

## Dispatch and recovery

After all gates pass, an authorized maintainer creates the version tag on the
reviewed default-branch commit and manually dispatches **Release** from that
same tag, passing it as `release_tag`. For example, after creating and reviewing
`v0.1.0`, dispatch with:

```sh
gh workflow run release.yml --ref v0.1.0 -f release_tag=v0.1.0
```

Selecting the default branch or a different tag as the workflow ref is rejected.
Do not override GitHub's source identity environment variables to bypass this
check. Approve the `npm` environment only after checking the exact commit,
validation results, and archive identity in that run. No workflow is authorized merely by having been added to
the repository.

If publication fails ambiguously, inspect the npm registry before retrying.
Published versions are immutable; never overwrite or reuse a version. For a
faulty release, stop subsequent releases, assess impact, document the correction
and publish a new version through the same checks. Follow the security policy
for confidential issues; deprecate affected versions when appropriate.

Artifacts are retained for seven days. If validation must be repeated or the
artifact has expired, dispatch a new run against the same reviewed tag. Do not
overwrite or substitute an existing run's archive. A publication-only retry must
still use that run's recorded artifact ID and SHA-256.

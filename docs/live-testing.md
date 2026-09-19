# Explicit live provider integration test

The ordinary tests and diagnostic engine operate offline. This optional development harness makes real requests to an S3 or R2 bucket you supply. It uploads disposable synthetic objects, reads the successful object back, and deletes the attempted keys. It does not create buckets, change CORS, read account configuration or test your production application.

This test must be run separately for S3 and R2. A successful local fixture test is not evidence that either provider integration has passed. A live pass applies only to this provider, bucket configuration, credential scope, SDK version and local browser flow.

## Prepare a dedicated bucket

Use a disposable **unversioned** test bucket. Grant the test identity object-scoped `PutObject`, `GetObject` and `DeleteObject` permissions only for the `upload-doctor/*` prefix. No bucket listing or administrative permissions are required by the harness. The equivalent R2 token needs object read and write access to the selected test bucket; use the narrowest scope available.

Do not use a production bucket. Each run creates a random `upload-doctor/<uuid>/` prefix and uses separate keys for the intentional failure and corrected upload. Cleanup attempts every key that may have been written, including after a failure or normal interruption. A failed cleanup makes the test fail and prints only its generated run prefix for manual cleanup.

Ordinary object deletion does not remove retained versions in a versioned S3 bucket. The harness fails if it detects a real object version or a deletion marker. It attempts to remove only the specific versions or markers identified in its own responses. That optional recovery needs `s3:DeleteObjectVersion`, scoped to the same prefix; without it, cleanup can fail and the generated prefix is printed for manual attention. This never counts as a successful versioned-bucket test, and it does not inspect or remove unrelated versions. No bucket-configuration permissions are used. Forced process termination, machine failure or expired credentials can also prevent cleanup.

Configure this CORS rule yourself before testing:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:43189"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 0
  }
]
```

The spelling of the origin matters: `localhost` and `127.0.0.1` are different origins. If you select a different port, update the rule to match. The independently authorized object read runs in Node and does not require browser `GET` CORS permission. The test never edits this rule or suggests wildcard origins.

See the provider instructions for [S3 CORS elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html) and [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## Install the development dependencies

```sh
npm ci
npx playwright install chromium
npm run build
```

The AWS SDK packages are development dependencies for this harness. They are not runtime dependencies of the offline diagnostic package.

## Provide explicit task-scoped environment variables

The harness does not read default AWS credentials, profiles or instance credentials. Supply all credentials through the following variables, using your normal local secret-injection mechanism. Do not paste real credentials into documentation, issue reports or shell history.

| Variable                               | Requirement                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOAD_DOCTOR_LIVE`                   | Must equal `1`; otherwise exit code 2 and no test runs.                                                                                                                          |
| `UPLOAD_DOCTOR_LIVE_PROVIDER`          | `s3` or `r2`.                                                                                                                                                                    |
| `UPLOAD_DOCTOR_LIVE_BUCKET`            | Dedicated, unversioned test bucket.                                                                                                                                              |
| `UPLOAD_DOCTOR_LIVE_ACCESS_KEY_ID`     | Explicit scoped test credential.                                                                                                                                                 |
| `UPLOAD_DOCTOR_LIVE_SECRET_ACCESS_KEY` | Explicit scoped test credential.                                                                                                                                                 |
| `UPLOAD_DOCTOR_LIVE_SESSION_TOKEN`     | Optional; required when your S3 credentials use a session token.                                                                                                                 |
| `UPLOAD_DOCTOR_LIVE_REGION`            | Required S3 region. For R2, omit or use `auto`.                                                                                                                                  |
| `UPLOAD_DOCTOR_LIVE_ENDPOINT`          | Required R2 S3 API account endpoint, using HTTPS. Optional standard S3 service endpoint; otherwise the SDK derives it from the explicit region. Custom domains are not accepted. |
| `UPLOAD_DOCTOR_LIVE_PORT`              | Optional local port, default `43189`; allowed range 1024–65535. CORS must match.                                                                                                 |

After those variables are configured:

```sh
npm run test:live
```

Missing or invalid configuration, absent explicit opt-in, or enabled `DEBUG`, `NODE_DEBUG` or `PWDEBUG` produces exit code **2**, not a passing skip. A failed test or cleanup produces **1**. Only the complete live test and cleanup produce **0**.

## What the harness proves

1. Generates a fresh presigned PUT URL with `Content-Type` explicitly included in `signableHeaders`. It checks the generated signature metadata before making the request.
2. Sends the wrong Content-Type from Chromium running the local application. Requires an observed provider 403 and a confirmed contract mismatch; a failed CORS preflight alone does not pass the negative test.
3. Generates another fresh URL and sends the correct Content-Type through the same browser flow, provider, bucket and contract. Requires storage acceptance, completed browser response and actual JavaScript access to ETag.
4. Records the application assertion against the specific completed upload attempt. Compares the failed and corrected captures and requires a `verified` result.
5. Uses a separately authorized SDK `GetObject` request to compare the stored bytes with the synthetic payload using SHA-256. An ETag is not treated as a content hash.
6. Attempts `DeleteObject` for every possibly written key in a `finally` block. Cleanup failure cannot produce a passing result.

The [AWS presigner documentation](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md) documents the explicit `signableHeaders` option. Setting `ContentType` on a command alone is not the test's proof that the header was signed.

This harness sets SDK checksum calculation and response validation to `WHEN_REQUIRED` to isolate the signed Content-Type behavior across S3 and R2. It verifies object integrity independently after upload. It does **not** validate default SDK checksum interoperability, multipart uploads, other regions, production application authentication or production application completion.

No raw HAR, trace, signed URL, provider exception body or credential is printed or saved. The pass/fail output uses fixed messages. A generated random cleanup prefix may be printed if cleanup needs attention. Do not enable SDK or browser debug logging while using real credentials.

The local HTTP server binds only to `127.0.0.1`, requires its exact Host and rejects conflicting Origin or cross-site fetch metadata. All responses disable caching. It serves a static test page and has **no signing route**: Node passes the two fresh URLs directly to its isolated Playwright page in memory. Custom provider domains and arbitrary endpoint overrides are rejected.

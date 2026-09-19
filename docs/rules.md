# Diagnostic rule catalog

These IDs are retained in shared reports. Shared output removes original
evidence, names and narrative; use your private local report to understand the
exact observation. A rule status and confidence are separate. Do not apply a
configuration change solely from a shared status without checking its evidence.

| Rule ID                  | Checked condition and limit                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload-scope`           | Recognized S3/R2 query-presigned SigV4 single PUT; other protocols remain unsupported.                                                                                        |
| `contract-method`        | Observed method matches the supplied signer contract; the signature does not reveal the expected method.                                                                      |
| `contract-content-type`  | Observed Content-Type matches an explicit expectation; absent or incomplete headers can leave it unknown.                                                                     |
| `contract-body`          | Raw versus FormData body shape agrees with the contract. Shape does not prove byte integrity.                                                                                 |
| `signed-headers`         | Required signed header names are present in complete evidence. Host is implicit in the URL; values and HMAC validity are not reconstructed.                                   |
| `url-expiry`             | Captured request time versus advertised validity window, or a provider expiration error. Clock differences limit a timestamp-only conclusion.                                 |
| `credential-expiry`      | Provider evidence of an expired token; URL timestamps cannot establish credential lifetime or revocation.                                                                     |
| `provider-rejection`     | Storage success or rejection, with a known provider code when available. A generic 403 does not identify a policy.                                                            |
| `cors-preflight`         | Available preflight outcome; a missing capture is not proof of no preflight.                                                                                                  |
| `cors-origin`            | Response origin behavior relative to the captured application origin.                                                                                                         |
| `cors-method`            | Captured preflight permits the requested operation.                                                                                                                           |
| `cors-headers`           | Captured preflight permits the request's relevant header names.                                                                                                               |
| `response-header-access` | The application can read required response headers, based on available CORS evidence or an explicit observation. DevTools visibility is not enough.                           |
| `region-redirect`        | Endpoint, redirect or region evidence needing signer inspection. Changing a signed URL's host is not a repair.                                                                |
| `r2-endpoint`            | R2 presigning requires the S3 API endpoint; a custom public domain cannot substitute for it.                                                                                  |
| `browser-outcome`        | A captured browser transport failure is a failure even when the provider response or exact network cause is unavailable. Completion alone does not prove application success. |
| `body-integrity`         | States that stored bytes were not independently verified; HTTP success is insufficient.                                                                                       |

The catalog is bounded. It is not a complete S3 compliance, IAM or storage
security test. See [diagnostics](diagnostics.md) for evidence semantics and
[automation](automation.md) for verification.

## Primary references

- [AWS presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [AWS CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
- [AWS 403 troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html)
- [AWS JS SDK checksums](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Firsthand raw-PUT/FormData report](https://github.com/aws/aws-sdk-js/issues/547)

Provider behavior can evolve. Changes to a rule require a source-backed failing
fixture, repaired fixture and negative control under the contributing policy.

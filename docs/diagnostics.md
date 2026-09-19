# Evidence and diagnostic coverage

Upload Doctor reports the facts of an observed application upload. Four
questions are separate:

1. Did storage accept the request?
2. Did the browser complete the request and make its response available?
3. Did the stored content match the application's intention?
4. Did the application finish its own upload flow?

An HTTP success response alone answers only the first question. This release
does not download objects to verify their bytes. Application completion needs
an explicit assertion supplied by the caller; a filename or a 200 response is
not a substitute.

## Status and confidence

| Finding status | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `pass`         | Available evidence satisfies this particular check.               |
| `fail`         | Evidence supports a problem; read its confidence and explanation. |
| `unknown`      | Required evidence is absent, incomplete or ambiguous.             |
| `unsupported`  | The observed flow is outside the implemented coverage.            |

Confidence is `confirmed`, `likely` or `unknown`. A likely finding supplies a
next step rather than a proven cause. A report retains capture limitations,
including truncation and missing fields, so automation can reject incomplete
coverage rather than treating it as success.

## Input limitations

HAR exports vary. They can omit bodies, sensitive headers, provider responses,
cached preflights and information about JavaScript-visible response headers.
Some fields exist only in browser capture. The absence of a recorded OPTIONS
request does not prove that no preflight occurred.

Browser observation covers selected storage traffic and preflights. It does not
capture the signing endpoint response or inspect the application backend. A
signing endpoint failure before storage is contacted may produce no upload
evidence. The tool reports this as incomplete rather than assuming storage is
working.

Origin includes scheme, hostname and port. A browser running the real staging
page supplies its staging origin. A request sent by curl with an Origin header
is evidence about the server response, not proof that a browser accepted it.
Service workers, redirects, proxies and opaque responses can limit observation.
When a service worker supplies a response, a 200 can be synthetic; browser
capture keeps provider acceptance unknown instead of claiming storage accepted
the upload.

The optional contract records intended storage hosts, provider, request method,
raw-body expectation, content type and response headers the application needs.
It is an assertion by the operator, not evidence recovered from a signature.
Signed header names can be recovered from a URL; signed header values and the
original method cannot be recovered from the HMAC.

Known S3/R2 endpoints establish bucket addressing automatically. A custom host
requires `pathStyle: true` for a bucket in the first URL path segment, or
`pathStyle: false` for a destination identified by its host. Without this
declaration, destination identity is unknown. Contract host selection alone
does not establish bucket identity.

## Comparing runs

Comparison results are `verified`, `improved`, `not-fixed` or `unknown`.
Verification requires comparable local reports, a supported fresh browser run,
sufficient successful checks and explicit application success evidence. An
offline capture or a reduction in failing findings can show improvement without
proving repair. Shared reports discard identity needed for reliable matching.

The private profile includes `requestStartedAt` and `destination`. Comparison
must establish a later request to the same destination, not merely the same
storage account endpoint. A different bucket cannot verify the earlier bucket's
repair. Reports are user-editable evidence, not signed attestations; validation
checks internal consistency and cannot prove that someone did not fabricate a
capture or assertion.

Repeat the application's normal flow with a fresh signature. Do not reuse an
expired URL or modify its host, path or signed headers. Use a new disposable
object when possible. The tool does not replay the original upload or make
cleanup requests automatically.

## Provider references

- [AWS presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
  describes expiration and credential lifetime constraints.
- [AWS CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
  documents allowed methods and exposed response headers. `OPTIONS` is not an
  allowed value in an S3 bucket rule's `AllowedMethods`.
- [AWS 403 troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html)
  covers multiple authorization causes; a generic denial does not identify one.
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
  covers browser requests and expiry errors lacking CORS headers.
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
  documents the S3 API endpoint requirement and unsupported presigned HTML POST.

Full multipart orchestration, presigned POST, resumable protocols and general S3
conformance testing are outside v0.1. Uppy and other uploaders can use multipart
even when their small-file flow uses PUT; check the actual captured flow.

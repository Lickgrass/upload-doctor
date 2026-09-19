import { createHash } from 'node:crypto';
import { diagnose, RULE_IDS } from './rules.js';
import { normalizeHar } from './normalize.js';
import { InputError, object, parseContract, safeUrl } from './validation.js';
import type {
  CaptureEvidence,
  Comparison,
  Contract,
  Finding,
  Profile,
  Report,
  UploadSummary,
} from './types.js';

export const VERSION = '0.1.0';
const IDS = new Set<string>(RULE_IDS);
const GENERIC_SOURCE = 'https://github.com/Lickgrass/upload-doctor/blob/main/docs/rules.md';
const requestId = (v: unknown): v is string =>
  typeof v === 'string' && /^upload-[1-9][0-9]{0,3}$/.test(v);
const optionalBool = (v: unknown): v is boolean | null => typeof v === 'boolean' || v === null;
const shortId = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v));
const isOrigin = (v: unknown): v is string | null =>
  v === null || v === 'null' || (typeof v === 'string' && safeUrl(v)?.origin === v);
const dateOrNull = (v: unknown): v is string | null =>
  v === null ||
  (typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)));
const destinationOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(v));
const digest = (contract: Contract): string =>
  createHash('sha256').update(JSON.stringify(contract)).digest('hex');

export function createReport(
  evidence: CaptureEvidence,
  contractInput?: Contract,
  selectedRequest?: string,
): Report {
  const contract = contractInput ? parseContract(contractInput) : undefined;
  if (selectedRequest && !evidence.requests.some((r) => r.id === selectedRequest))
    throw new InputError('Selected upload was not found in the capture.');
  const selected = selectedRequest
    ? { ...evidence, requests: evidence.requests.filter((r) => r.id === selectedRequest) }
    : evidence;
  const findings = diagnose(selected, contract);
  const profiles: Profile[] = selected.requests.map((r) => {
    const matched =
      contract &&
      contract.storageHosts.includes(safeUrl(r.endpoint)?.hostname ?? '') &&
      (!contract.provider || contract.provider === r.provider)
        ? contract
        : undefined;
    return {
      requestId: r.id,
      requestStartedAt: r.startedAt,
      origin: r.origin,
      endpoint: r.endpoint,
      destination: r.destination ?? null,
      provider: r.provider,
      method: r.method,
      contractId: matched?.id ?? null,
      contractDigest: matched ? digest(matched) : null,
      applicationAssertion: evidence.source === 'browser' ? r.applicationAssertion : null,
    };
  });
  const uploads: UploadSummary[] = selected.requests.map((r) => ({
    requestId: r.id,
    storageAccepted: r.status === null ? null : r.status >= 200 && r.status < 300,
    browserCompleted: evidence.source === 'browser' ? r.browserCompleted : null,
    applicationSuccess: evidence.source === 'browser' ? r.applicationSuccess : null,
    supported: !findings.some(
      (f) => f.requestId === r.id && f.ruleId === 'upload-scope' && f.status === 'unsupported',
    ),
  }));
  return {
    schemaVersion: 1,
    toolVersion: VERSION,
    source: evidence.source,
    capturedAt: evidence.capturedAt,
    visibility: 'local',
    profiles,
    uploads,
    findings,
    coverage: {
      uploadsObserved: uploads.length,
      supportedUploads: uploads.filter((u) => u.supported).length,
      truncated: evidence.truncated,
      limitations: [...evidence.limitations],
    },
  };
}
export function inspectHar(
  input: unknown,
  options: { contract?: Contract; requestId?: string } = {},
): Report {
  return createReport(normalizeHar(input, options.contract), options.contract, options.requestId);
}

/** Validate imported reports structurally. Their free-text fields are never trusted for sharing. */
export function validateReport(input: unknown): Report {
  if (
    !object(input) ||
    input.schemaVersion !== 1 ||
    typeof input.source !== 'string' ||
    !['har', 'browser'].includes(input.source) ||
    typeof input.visibility !== 'string' ||
    !['local', 'share'].includes(input.visibility) ||
    typeof input.toolVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.toolVersion) ||
    typeof input.capturedAt !== 'string' ||
    input.capturedAt.length > 40 ||
    !Number.isFinite(Date.parse(input.capturedAt))
  )
    throw new InputError('Invalid or unsupported report format.');
  if (
    !Array.isArray(input.profiles) ||
    !Array.isArray(input.uploads) ||
    !Array.isArray(input.findings) ||
    input.profiles.length > 1000 ||
    input.uploads.length !== input.profiles.length ||
    input.findings.length > 20000 ||
    !object(input.coverage)
  )
    throw new InputError('Invalid report structure or limits.');
  const profiles: Profile[] = input.profiles.map((p: unknown) => {
    if (
      !object(p) ||
      !requestId(p.requestId) ||
      !dateOrNull(p.requestStartedAt) ||
      !destinationOrNull(p.destination) ||
      !isOrigin(p.origin) ||
      !(
        typeof p.endpoint === 'string' &&
        ((input.visibility === 'share' && p.endpoint === '[redacted]') ||
          safeUrl(p.endpoint)?.origin === p.endpoint)
      ) ||
      typeof p.provider !== 'string' ||
      !['s3', 'r2', 'unknown'].includes(p.provider) ||
      typeof p.method !== 'string' ||
      !/^[A-Z]{1,16}$/.test(p.method) ||
      !shortId(p.contractId) ||
      !(
        p.contractDigest === null ||
        (typeof p.contractDigest === 'string' && /^[a-f0-9]{64}$/.test(p.contractDigest))
      ) ||
      !shortId(p.applicationAssertion)
    )
      throw new InputError('Invalid report upload profile.');
    return {
      requestId: p.requestId,
      requestStartedAt: p.requestStartedAt,
      origin: p.origin,
      endpoint: p.endpoint,
      destination: p.destination,
      provider: p.provider as Profile['provider'],
      method: p.method,
      contractId: p.contractId,
      contractDigest: p.contractDigest,
      applicationAssertion: p.applicationAssertion,
    };
  });
  const identifiers = new Set(profiles.map((p) => p.requestId));
  if (identifiers.size !== profiles.length)
    throw new InputError('Duplicate report upload identifier.');
  const uploads: UploadSummary[] = input.uploads.map((u: unknown) => {
    if (
      !object(u) ||
      !requestId(u.requestId) ||
      !identifiers.has(u.requestId) ||
      !optionalBool(u.storageAccepted) ||
      !optionalBool(u.browserCompleted) ||
      !optionalBool(u.applicationSuccess) ||
      typeof u.supported !== 'boolean'
    )
      throw new InputError('Invalid report upload outcome.');
    return {
      requestId: u.requestId,
      storageAccepted: u.storageAccepted,
      browserCompleted: u.browserCompleted,
      applicationSuccess: u.applicationSuccess,
      supported: u.supported,
    };
  });
  if (new Set(uploads.map((u) => u.requestId)).size !== uploads.length)
    throw new InputError('Duplicate report upload outcome.');
  const findings: Finding[] = input.findings.map((f: unknown) => {
    if (
      !object(f) ||
      typeof f.ruleId !== 'string' ||
      !IDS.has(f.ruleId) ||
      !requestId(f.requestId) ||
      !identifiers.has(f.requestId) ||
      typeof f.status !== 'string' ||
      !['fail', 'pass', 'unknown', 'unsupported'].includes(f.status) ||
      typeof f.confidence !== 'string' ||
      !['confirmed', 'likely', 'unknown'].includes(f.confidence) ||
      !Array.isArray(f.evidence) ||
      f.evidence.length > 32 ||
      f.evidence.some((e) => typeof e !== 'string' || e.length > 2048) ||
      ['title', 'explanation', 'recommendation', 'verification', 'source'].some(
        (k) => typeof f[k] !== 'string' || (f[k] as string).length > 4096,
      )
    )
      throw new InputError('Invalid report finding.');
    return {
      ruleId: f.ruleId,
      requestId: f.requestId,
      status: f.status as Finding['status'],
      confidence: f.confidence as Finding['confidence'],
      title: f.title as string,
      explanation: f.explanation as string,
      recommendation: f.recommendation as string,
      verification: f.verification as string,
      source: f.source as string,
      evidence: f.evidence as string[],
    };
  });
  if (new Set(findings.map((f) => `${f.requestId}:${f.ruleId}`)).size !== findings.length)
    throw new InputError('Duplicate report finding.');
  const c = input.coverage;
  if (
    c.uploadsObserved !== uploads.length ||
    c.supportedUploads !== uploads.filter((u) => u.supported).length ||
    typeof c.truncated !== 'boolean' ||
    !Array.isArray(c.limitations) ||
    c.limitations.length > 64 ||
    c.limitations.some((v) => typeof v !== 'string' || v.length > 1024)
  )
    throw new InputError('Invalid report coverage.');
  return {
    schemaVersion: 1,
    toolVersion: input.toolVersion,
    source: input.source as Report['source'],
    capturedAt: input.capturedAt,
    visibility: input.visibility as Report['visibility'],
    profiles,
    uploads,
    findings,
    coverage: {
      uploadsObserved: uploads.length,
      supportedUploads: uploads.filter((u) => u.supported).length,
      truncated: c.truncated,
      limitations: c.limitations as string[],
    },
  };
}

/** Share exports keep rule outcomes but discard arbitrary imported narrative and private identifiers. */
export function shareReport(input: unknown): Report {
  const report = validateReport(input);
  return {
    ...report,
    toolVersion: VERSION,
    capturedAt: new Date(report.capturedAt).toISOString(),
    visibility: 'share',
    profiles: report.profiles.map((p) => ({
      ...p,
      requestStartedAt: null,
      method: ['PUT', 'POST', 'GET', 'HEAD', 'DELETE', 'OPTIONS', 'PATCH'].includes(p.method)
        ? p.method
        : 'UNKNOWN',
      origin: null,
      endpoint: '[redacted]',
      destination: null,
      contractId: null,
      contractDigest: null,
      applicationAssertion: null,
    })),
    findings: report.findings.map((f) => ({
      ruleId: f.ruleId,
      requestId: f.requestId,
      status: f.status,
      confidence: f.confidence,
      title: f.ruleId,
      evidence: [],
      explanation:
        'Rule outcome retained from the local report; private evidence and free text omitted.',
      recommendation:
        'Consult the rule documentation and original local report for the correction.',
      verification:
        'Reproduce using the same application flow and compare the private local reports.',
      source: GENERIC_SOURCE,
    })),
    coverage: {
      ...report.coverage,
      limitations: [
        'Share export omits private evidence and cannot establish comparable origins or application contracts.',
      ],
    },
  };
}

function comparison(
  status: Comparison['status'],
  reason: string,
  resolvedRules: string[] = [],
  remainingRules: string[] = [],
): Comparison {
  return { schemaVersion: 1, status, reason, resolvedRules, remainingRules };
}
/** A fresh application assertion is required; an HTTP success alone never verifies a fix. */
export function compareReports(beforeInput: unknown, afterInput: unknown): Comparison {
  const before = validateReport(beforeInput);
  const after = validateReport(afterInput);
  if (before.visibility !== 'local' || after.visibility !== 'local')
    return comparison(
      'unknown',
      'Shared reports cannot establish comparable origins or contracts.',
    );
  if (before.toolVersion !== VERSION || after.toolVersion !== VERSION)
    return comparison(
      'unknown',
      'Comparison requires reports generated by this diagnostic version.',
    );
  if (
    before.coverage.truncated ||
    after.coverage.truncated ||
    before.uploads.length !== 1 ||
    after.uploads.length !== 1
  )
    return comparison('unknown', 'Comparison requires one selected upload per complete report.');
  const bp = before.profiles[0]!;
  const ap = after.profiles[0]!;
  const au = after.uploads[0]!;
  if (!before.uploads[0]!.supported || !au.supported)
    return comparison('unknown', 'The upload flow is outside supported coverage.');
  const mandatory = RULE_IDS.filter((id) => id !== 'contract-method' && id !== 'r2-endpoint');
  for (const report of [before, after]) {
    const map = new Map(report.findings.map((f) => [f.ruleId, f]));
    if (
      mandatory.some((id) => !map.has(id)) ||
      (report.profiles[0]!.provider === 'r2' && !map.has('r2-endpoint')) ||
      map.get('upload-scope')?.status !== 'pass' ||
      report.findings.some((f) => f.status === 'unsupported') ||
      (report.uploads[0]!.storageAccepted === true &&
        map.get('provider-rejection')?.status !== 'pass')
    )
      return comparison(
        'unknown',
        'Required diagnostic coverage is missing or contradicts the upload outcome.',
      );
  }
  if (
    !bp.origin ||
    bp.origin === 'null' ||
    bp.origin !== ap.origin ||
    bp.endpoint !== ap.endpoint ||
    !bp.destination ||
    bp.destination !== ap.destination ||
    bp.provider !== ap.provider ||
    bp.method !== ap.method
  )
    return comparison(
      'unknown',
      'Upload origin, endpoint, bucket, provider, or method differs or is missing.',
    );
  if (Date.parse(after.capturedAt) <= Date.parse(before.capturedAt))
    return comparison('unknown', 'Verification requires a later capture.');
  if (
    !bp.requestStartedAt ||
    !ap.requestStartedAt ||
    Date.parse(ap.requestStartedAt) <= Date.parse(bp.requestStartedAt)
  )
    return comparison(
      'unknown',
      'Verification requires a later upload attempt, not just a later report.',
    );
  const previous = new Set(before.findings.filter((f) => f.status === 'fail').map((f) => f.ruleId));
  const remaining = [
    ...new Set(after.findings.filter((f) => f.status === 'fail').map((f) => f.ruleId)),
  ].sort();
  // Absence or unknown is not evidence of resolution. Require an explicit new pass.
  const passes = new Set(
    after.findings
      .filter((f) => f.status === 'pass' && f.confidence === 'confirmed')
      .map((f) => f.ruleId),
  );
  const resolved = [...previous].filter((id) => passes.has(id)).sort();
  if (remaining.length)
    return comparison(
      'not-fixed',
      'The later upload still has detected failures.',
      resolved,
      remaining,
    );
  if (!previous.size)
    return comparison('unknown', 'The earlier report has no detected failure to verify.');
  if (resolved.length !== previous.size)
    return comparison(
      'unknown',
      'Earlier failures lack explicit passing evidence in the later capture.',
      resolved,
    );
  if (
    !bp.contractDigest ||
    bp.contractDigest !== ap.contractDigest ||
    bp.contractId !== ap.contractId ||
    !bp.applicationAssertion ||
    bp.applicationAssertion !== ap.applicationAssertion
  )
    return comparison(
      'improved',
      'Detected failures passed, but matching contracts and application assertions are required to verify the repair.',
      resolved,
    );
  if (
    before.source !== 'browser' ||
    after.source !== 'browser' ||
    au.storageAccepted !== true ||
    au.browserCompleted !== true ||
    au.applicationSuccess !== true
  )
    return comparison(
      'improved',
      'Detected failures passed; browser and correlated application success remain unverified.',
      resolved,
    );
  return comparison(
    'verified',
    'The earlier failures passed in a later comparable browser upload, and the declared application assertion succeeded. File integrity is not implied.',
    resolved,
  );
}

export function reportExitCode(report: Report, strict = false): number {
  if (report.findings.some((f) => f.status === 'fail')) return 1;
  if (
    !report.uploads.length ||
    report.coverage.truncated ||
    report.uploads.some((u) => !u.supported) ||
    (strict && report.findings.some((f) => f.status === 'unknown'))
  )
    return 3;
  return 0;
}
/** Escapes terminal and bidirectional controls in display lines; this is not HTML escaping. */
export function formatReport(report: Report): string {
  const lines = [
    `Upload Doctor ${VERSION}`,
    `${report.coverage.uploadsObserved} upload(s) observed; ${report.coverage.supportedUploads} within supported scope.`,
    '',
  ];
  for (const f of report.findings.filter((v) => v.status !== 'pass')) {
    lines.push(
      `${f.status.toUpperCase()} ${f.requestId} / ${f.ruleId} [${f.confidence}]`,
      `  ${f.title}`,
      `  ${f.explanation}`,
      `  Next: ${f.recommendation}`,
    );
  }
  if (!report.findings.some((f) => f.status === 'fail'))
    lines.push(
      'No failure detected in available evidence. This is not proof of application success.',
    );
  lines.push('', ...report.coverage.limitations.map((v) => `Coverage: ${v}`));
  return `${lines
    .map((line) =>
      line.replace(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    )
    .join('\n')}\n`;
}

/** Private normalized evidence: never serialize these inputs directly. */
export type Provider = 's3' | 'r2' | 'unknown';
export type Confidence = 'confirmed' | 'likely' | 'unknown';
export type Status = 'fail' | 'pass' | 'unknown' | 'unsupported';
export interface Contract {
  version: 1;
  id: string;
  storageHosts: string[];
  provider?: 's3' | 'r2';
  method?: 'PUT';
  body?: 'raw' | 'any';
  contentType?: string;
  requiredResponseHeaders?: string[];
  /** Required for comparison on custom hosts: true means /bucket/key addressing. */
  pathStyle?: boolean;
}
export interface RequestEvidence {
  id: string;
  startedAt: string | null;
  method: string;
  endpoint: string;
  /** Private bucket identity, excluding object key and signing parameters. */
  destination?: string | null;
  origin: string | null;
  provider: Provider;
  headers: Record<string, string>;
  headersComplete: boolean;
  responseHeaders: Record<string, string>;
  responseHeadersComplete: boolean;
  status: number | null;
  providerCode: string | null;
  signedHeaders: string[];
  signedAt: string | null;
  expiresSeconds: number | null;
  signatureVersion: string | null;
  temporaryCredentials: boolean;
  bodyKind: 'raw' | 'form-data' | 'unknown';
  multipart: boolean;
  browserCorsError: boolean;
  browserCompleted: boolean | null;
  preflight: {
    status: number | null;
    headers: Record<string, string>;
    headersComplete?: boolean;
    requestedHeaders: string[];
    requestedMethod: string;
  } | null;
  redirectRegion: string | null;
  responseHeaderAccess: Record<string, boolean> | null;
  applicationSuccess: boolean | null;
  applicationAssertion: string | null;
}
export interface CaptureEvidence {
  source: 'har' | 'browser';
  capturedAt: string;
  requests: RequestEvidence[];
  limitations: string[];
  truncated: boolean;
}
export interface Finding {
  ruleId: string;
  requestId: string;
  status: Status;
  confidence: Confidence;
  title: string;
  evidence: string[];
  explanation: string;
  recommendation: string;
  verification: string;
  source: string;
}
export interface Profile {
  requestId: string;
  requestStartedAt: string | null;
  origin: string | null;
  endpoint: string;
  destination: string | null;
  provider: Provider;
  method: string;
  contractId: string | null;
  contractDigest: string | null;
  applicationAssertion: string | null;
}
export interface UploadSummary {
  requestId: string;
  storageAccepted: boolean | null;
  browserCompleted: boolean | null;
  applicationSuccess: boolean | null;
  supported: boolean;
}
export interface Report {
  schemaVersion: 1;
  toolVersion: string;
  source: 'har' | 'browser';
  capturedAt: string;
  visibility: 'local' | 'share';
  profiles: Profile[];
  uploads: UploadSummary[];
  findings: Finding[];
  coverage: {
    uploadsObserved: number;
    supportedUploads: number;
    truncated: boolean;
    limitations: string[];
  };
}
export interface Comparison {
  schemaVersion: 1;
  status: 'verified' | 'improved' | 'not-fixed' | 'unknown';
  reason: string;
  resolvedRules: string[];
  remainingRules: string[];
}

export type SourceStatus = "installed" | "draft" | "registered";

export interface LocalSurfaceSource {
  sourceId: string;
  id: string;
  name: string;
  version: string;
  description: string;
  status: SourceStatus;
  revision: {
    version: string;
    sourceDigest: string;
    gitHead: string | null;
  };
  hasGit: boolean;
  hasPackageJson: boolean;
  buildGranted: boolean;
}

export type SecretSeverity = "block" | "warning";

export interface SecurityFinding {
  path: string;
  ruleId: string;
  severity: SecretSeverity;
  reason: string;
}

export interface SecurityScanResult {
  clean: boolean;
  blocked: boolean;
  requiresReview: boolean;
  targetDigest: string;
  scannedFiles: number;
  findings: SecurityFinding[];
  excluded: string[];
}

export interface PublicationApproval {
  digest: string;
  remote: string;
  targetRef: string;
  acknowledgedWarnings: boolean;
  distributionDigest?: string;
}

export interface GitHubStatus {
  connected: boolean;
  username: string | null;
  source: "token" | "gh_cli" | "none";
}

export interface PackagePrepareResult {
  ok: true;
  mode: "use_only";
  preparedId: string;
  surfaceId: string;
  version: string;
  repo: string;
  tag: string;
  packagePath: string;
  archiveSha256: string;
  archiveBytes: number;
  bundleDigest: string;
  filesCount: number;
  excluded: string[];
  scan: SecurityScanResult;
  consentPrompt: string;
  distribution: { commit: string; branch: string; files: Array<{ path: string; status: string }> };
}

export interface SourcePrepareResult {
  ok: true;
  mode: "open_source";
  preparedId: string;
  surfaceId: string;
  repo: string;
  branch: string;
  stagingId: string;
  commit: string;
  filesCount: number;
  excluded: string[];
  scan: SecurityScanResult;
  preview: {
    commits: number;
    files: Array<{ path: string; status: string }>;
    remoteSlug: string | null;
    consent: string | null;
    blocked: string | null;
  };
}

export interface PublishPackageParams {
  sourceId: string;
  preparedId?: string;
  repo?: string;
  tag?: string;
  notes?: string;
  ownerAccount?: string;
  dryRun?: boolean;
  skipBuild?: boolean;
  confirmRemote?: string;
  approval?: PublicationApproval;
}

export interface PublishPackageResult {
  ok: boolean;
  mode: "use_only";
  dryRun: boolean;
  surfaceId: string;
  version: string;
  repo: string;
  tag: string;
  packagePath: string;
  bundleDigest: string;
  archiveSha256: string;
  filesCount: number;
  excluded: string[];
  releaseUrl: string;
}

export interface PublishSourceParams {
  sourceId: string;
  preparedId?: string;
  repo?: string;
  branch?: string;
  message?: string;
  ownerAccount?: string;
  dryRun?: boolean;
  confirmRemote?: string;
  approval?: PublicationApproval;
}

export interface PublishSourceResult {
  ok: boolean;
  mode: "open_source";
  dryRun: boolean;
  surfaceId: string;
  repo: string;
  branch: string;
  commit: string | null;
  repoUrl: string;
  excluded: string[];
  filesCount: number;
}

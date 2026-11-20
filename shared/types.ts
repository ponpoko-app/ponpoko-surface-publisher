export interface LocalSurfaceSource {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  hasGit: boolean;
  hasPackageJson: boolean;
}

export interface SecurityFinding {
  path: string;
  reason: string;
}

export interface SecurityScanResult {
  clean: boolean;
  scannedFiles: number;
  findings: SecurityFinding[];
  excluded: string[];
}

export interface GitHubStatus {
  connected: boolean;
  username: string | null;
  source: "token" | "gh_cli" | "none";
}

export interface PublishPackageParams {
  path: string;
  repo?: string;
  tag?: string;
  notes?: string;
  ownerAccount?: string;
  dryRun?: boolean;
  skipBuild?: boolean;
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
  filesCount: number;
  excluded: string[];
  releaseUrl: string;
}

export interface PublishSourceParams {
  path: string;
  repo?: string;
  branch?: string;
  message?: string;
  ownerAccount?: string;
  dryRun?: boolean;
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

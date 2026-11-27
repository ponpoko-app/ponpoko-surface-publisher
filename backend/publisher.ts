import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PackagePrepareResult,
  PublicationApproval,
  PublishPackageParams,
  PublishPackageResult,
  PublishSourceParams,
  PublishSourceResult,
  SecretSeverity,
  SecurityScanResult,
  SourcePrepareResult,
} from "../shared/types";

export interface HostControlEndpoint {
  protocol?: number;
  url?: string;
  token?: string;
}

export interface PublisherOptions {
  dataDir: string;
  hostControlPath?: string;
  surfaceId?: string;
  fetchImpl?: typeof fetch;
  disableGhCli?: boolean;
  onHostJob?: (requestId: string, operation: string) => Promise<void>;
}

interface HostJob<T> {
  state: "running" | "completed" | "failed";
  result?: T;
  error?: string;
}

interface HostManagedSource {
  source_id: string;
  id: string;
  name: string;
  version: string;
  description: string;
  status: "installed" | "draft" | "registered";
  revision: {
    version: string;
    source_digest: string;
    git_head: string | null;
  };
  has_git: boolean;
  has_package_json: boolean;
  build_granted: boolean;
}

interface HostScanFinding {
  path: string;
  rule_id: string;
  severity: SecretSeverity;
  reason: string;
}

interface HostScanReport {
  clean: boolean;
  blocked: boolean;
  requires_review: boolean;
  target_digest: string;
  scanned_files: number;
  findings: HostScanFinding[];
  excluded: string[];
}

interface HostBuildReport {
  ok: boolean;
  failed_step?: string | null;
  bundle_root: string;
  build_id?: string;
  steps?: Array<{ step: string; ok: boolean; detail: string }>;
}

interface HostPackageReport {
  path: string;
  sha256: string;
  archive_bytes: number;
  target_label?: string;
  metadata: {
    id: string;
    version: string;
    bundle_digest: string;
    spec: { target: string; minimum_host_version: string };
    files: Array<{ path: string; bytes: number; sha256: string; executable: boolean }>;
  };
  scan?: HostScanReport;
}

interface HostGitPrepareReport {
  staging_id: string;
  commit: string;
  repo: string;
  branch: string;
  files_count: number;
  excluded: string[];
  scan: HostScanReport;
  preview: {
    commits: number;
    files: Array<{ path: string; status: string }>;
    remote_slug: string | null;
    consent: string | null;
    blocked: string | null;
  };
}

interface HostGitPushReport {
  pushed: boolean;
  branch: string | null;
  remote: string | null;
  detail: string;
}

interface GitHubRepository {
  full_name: string;
  html_url: string;
  default_branch?: string;
  created?: boolean;
}

interface GitHubRelease {
  id: number;
  html_url: string;
  upload_url: string;
  draft: boolean;
  immutable: boolean;
  tag_name: string;
}

interface StoredGitHubAuth {
  token: string;
  username: string;
}

type PreparedPublication =
  | { sourceId: string; result: SourcePrepareResult }
  | { sourceId: string; result: PackagePrepareResult; distribution: HostGitPrepareReport; notes?: string };

const OWNER_ACCOUNT_RE = /^acct_[A-Za-z0-9_-]{1,80}$/;

function mapScan(report: HostScanReport): SecurityScanResult {
  return {
    clean: report.clean,
    blocked: report.blocked,
    requiresReview: report.requires_review,
    targetDigest: report.target_digest,
    scannedFiles: report.scanned_files,
    findings: report.findings.map((f) => ({
      path: f.path,
      ruleId: f.rule_id,
      severity: f.severity,
      reason: f.reason,
    })),
    excluded: report.excluded,
  };
}

function redactSecret(text: string, secret?: string | null): string {
  let out = text.replace(/(https?:\/\/)[^/\s@]+@/g, "$1");
  const clean = secret?.trim();
  if (clean && clean.length >= 4) {
    out = out.split(clean).join("[REDACTED]");
  }
  return out;
}

function validateOwnerAccount(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!OWNER_ACCOUNT_RE.test(trimmed)) {
    throw new Error("Invalid Ponpoko Cloud account id (expected acct_...)");
  }
  return trimmed;
}

function verifyReviewAndRemote(
  scan: SecurityScanResult,
  confirmRemote: string | undefined,
  resolvedRepo: string,
  targetRef: string,
  approval: PublicationApproval | undefined,
): void {
  if (scan.blocked) {
    const details = scan.findings
      .filter((f) => f.severity === "block")
      .map((f) => `${f.path} [${f.ruleId}]: ${f.reason}`)
      .join("; ");
    throw new Error(`Security scan blocked publication: ${details}`);
  }
  if ((confirmRemote?.trim().toLowerCase() ?? "") !== resolvedRepo.toLowerCase()) {
    throw new Error(`Please confirm the destination repository '${resolvedRepo}' before publishing.`);
  }
  if (!approval || approval.digest !== scan.targetDigest ||
      approval.remote.toLowerCase() !== resolvedRepo.toLowerCase() || approval.targetRef !== targetRef ||
      (scan.requiresReview && approval.acknowledgedWarnings !== true)) {
    throw new Error("Publication requires your explicit review confirmation for this exact artifact/commit, remote, and branch/tag.");
  }
}

export class PublisherService {
  private readonly dataDir: string;
  private readonly hostControlPath: string | null;
  private readonly surfaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly disableGhCli: boolean;
  private readonly onHostJob: PublisherOptions["onHostJob"];

  constructor(options: PublisherOptions) {
    this.dataDir = resolve(options.dataDir);
    this.hostControlPath = options.hostControlPath ?? process.env.PONPOKO_HOST_CONTROL ?? null;
    this.surfaceId = options.surfaceId ?? process.env.PONPOKO_SURFACE_ID ?? "surface-publisher";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.disableGhCli = options.disableGhCli ?? false;
    this.onHostJob = options.onHostJob;
  }

  private async callHostRuntime<T>(operation: string, extra: Record<string, unknown>): Promise<T> {
    if (!this.hostControlPath) {
      throw new Error("Host control endpoint (PONPOKO_HOST_CONTROL) is required to build, scan, or pack surfaces.");
    }
    const endpoint = JSON.parse(await readFile(this.hostControlPath, "utf8")) as HostControlEndpoint;
    if (endpoint.protocol !== 1 || !endpoint.url || !endpoint.token) {
      throw new Error("Invalid Host control endpoint configuration.");
    }
    const url = new URL(endpoint.url);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Host control endpoint must use loopback HTTP.");
    }
    const response = await this.fetchImpl(endpoint.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        protocol: 1,
        verb: "runtime",
        surface_id: this.surfaceId,
        extra: { operation, ...extra },
      }),
    });
    const answer = (await response.json()) as { ok?: boolean; error?: string; snapshot?: T };
    if (!response.ok || answer.ok !== true || answer.snapshot === undefined) {
      throw new Error(answer.error || `Host runtime operation '${operation}' failed (${response.status})`);
    }
    return answer.snapshot;
  }

  async hostJobStatus(requestId: string): Promise<HostJob<unknown>> {
    return this.callHostRuntime("jobs.status", { request_id: requestId });
  }

  private async callHostJob<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    await this.onHostJob?.(id, operation);
    let job = await this.callHostRuntime<HostJob<T>>("jobs.start", {
      request_id: id, job_operation: operation, input,
    });
    while (job.state === "running") {
      await Bun.sleep(200);
      job = await this.callHostRuntime<HostJob<T>>("jobs.status", { request_id: id });
    }
    if (job.state !== "completed" || job.result === undefined) {
      throw new Error(job.error ?? "Host did not record a job outcome.");
    }
    return job.result;
  }

  private async savePreparation(prepared: PreparedPublication): Promise<void> {
    const dir = join(this.dataDir, "publication-previews");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${prepared.result.preparedId}.json`), JSON.stringify(prepared), { flag: "wx", mode: 0o600 });
  }

  private async loadPreparation(id: string | undefined, sourceId: string): Promise<PreparedPublication> {
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Prepare and review the publication first.");
    const path = join(this.dataDir, "publication-previews", `${id}.json`);
    const prepared = await readFile(path, "utf8").then(text => JSON.parse(text) as PreparedPublication)
      .catch(() => { throw new Error("Prepared publication is unavailable. Prepare and review it again."); });
    if (prepared.sourceId !== sourceId) throw new Error("Selected source changed after review.");
    return prepared;
  }

  private authPath(): string {
    return join(this.dataDir, "github-auth.json");
  }

  private async cleanupLegacyGitPublish(): Promise<void> {
    await rm(join(this.dataDir, "git-publish"), { recursive: true, force: true }).catch(() => {});
  }

  private async readStoredAuth(): Promise<StoredGitHubAuth | null> {
    try {
      if (!(await lstat(this.authPath())).isFile()) return null;
      const file = await open(this.authPath(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let parsed: Partial<StoredGitHubAuth>;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 4096) return null;
        const bytes = Buffer.alloc(4097);
        const { bytesRead } = await file.read(bytes);
        if (bytesRead > 4096) return null;
        parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await file.close();
      }
      if (typeof parsed.token === "string" && parsed.token.trim().length > 0) {
        return {
          token: parsed.token.trim(),
          username: typeof parsed.username === "string" ? parsed.username : "github-user",
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private readGhCliToken(): string | null {
    if (this.disableGhCli) return null;
    try {
      const out = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
      if (out.exitCode !== 0) return null;
      const token = new TextDecoder().decode(out.stdout).trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  async appInfo(): Promise<{ id: string; name: string; version: string }> {
    return { id: "surface-publisher", name: "Publisher", version: "1.0.0" };
  }

  async cloudAccount(): Promise<{ accountId: string | null }> {
    const res = await this.callHostRuntime<{ account_id: string | null }>("cloud.account", {});
    return { accountId: res.account_id ?? null };
  }

  async listSources(): Promise<LocalSurfaceSource[]> {
    const rows = await this.callHostJob<HostManagedSource[]>("sources.list", {});
    return rows.map((row) => ({
      sourceId: row.source_id,
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      status: row.status,
      revision: {
        version: row.revision.version,
        sourceDigest: row.revision.source_digest,
        gitHead: row.revision.git_head,
      },
      hasGit: row.has_git,
      hasPackageJson: row.has_package_json,
      buildGranted: row.build_granted,
    }));
  }

  async pickSource(): Promise<string | null> {
    const registered = await this.callHostJob<HostManagedSource | null>("sources.pick", {});
    return registered?.source_id ?? null;
  }

  async requestBuild(sourceId: string): Promise<{ sourceId: string; buildGranted: boolean }> {
    const res = await this.callHostJob<{ source_id: string; build_granted: boolean }>(
      "sources.request_build",
      { source_id: sourceId },
    );
    return { sourceId: res.source_id, buildGranted: res.build_granted };
  }

  async scanSecurity(sourceId: string): Promise<SecurityScanResult> {
    const report = await this.callHostJob<HostScanReport>("package.scan_secrets", {
      source_id: sourceId,
    });
    return mapScan(report);
  }

  async githubStatus(): Promise<GitHubStatus> {
    const stored = await this.readStoredAuth();
    if (stored) {
      return { connected: true, username: stored.username, source: "token" };
    }
    const ghToken = this.readGhCliToken();
    if (ghToken) {
      return { connected: true, username: "gh-cli", source: "gh_cli" };
    }
    return { connected: false, username: null, source: "none" };
  }

  async githubConnect(token: string): Promise<GitHubStatus> {
    const clean = token.trim();
    if (!/^[!-~]{1,1024}$/.test(clean)) throw new Error("A valid GitHub token is required");
    const response = await this.githubRequest("/user", clean);
    if (!response.ok) {
      throw new Error(`GitHub authentication failed (${response.status})`);
    }
    const user = (await response.json()) as { login?: string };
    const username = user.login;
    if (!username || !/^[a-z0-9-]{1,100}$/i.test(username)) throw new Error("Could not verify the GitHub account name");
    await mkdir(this.dataDir, { recursive: true });
    const staged = join(this.dataDir, `.github-auth-${randomUUID()}.tmp`);
    try {
      await writeFile(staged, JSON.stringify({ token: clean, username }, null, 2), { flag: "wx", mode: 0o600 });
      await rename(staged, this.authPath());
    } finally {
      await rm(staged, { force: true });
    }
    return { connected: true, username, source: "token" };
  }

  async githubDisconnect(): Promise<GitHubStatus> {
    await rm(this.authPath(), { force: true });
    return this.githubStatus();
  }

  private async activeToken(): Promise<{ token: string; username: string }> {
    const stored = await this.readStoredAuth();
    if (stored) return stored;
    const cli = this.readGhCliToken();
    if (cli) {
      const resp = await this.githubRequest("/user", cli);
      const user = resp.ok ? ((await resp.json()) as { login?: string }) : {};
      return { token: cli, username: user.login ?? "github-user" };
    }
    throw new Error("Please connect your GitHub account before publishing");
  }

  private async resolveRepoSlug(repoInput?: string, surfaceId?: string): Promise<{ slug: string; auth: { token: string; username: string } | null }> {
    const raw = repoInput?.trim();
    const auth = await this.activeToken().catch(() => null);
    const slug = raw?.includes("/") ? raw : `${auth?.username ?? "local"}/${raw || `ponpoko-${surfaceId ?? "surface"}`}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(slug) || /\/(?:\.|\.\.)$/.test(slug)) {
      throw new Error("Expected a GitHub repository name or owner/repo.");
    }
    return { slug, auth };
  }

  private async githubRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("User-Agent", "ponpoko-surface-publisher");
    headers.set("X-GitHub-Api-Version", "2026-03-10");
    return this.fetchImpl(`https://api.github.com${path}`, {
      ...init, headers, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  }

  private async findGitHubRepo(token: string, repo: string): Promise<GitHubRepository | null> {
    const response = await this.githubRequest(`/repos/${repo}`, token);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not verify GitHub repository '${repo}' (HTTP ${response.status}).`);
    const result = await response.json() as GitHubRepository;
    if (result.full_name?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("GitHub returned a repository other than the reviewed destination.");
    }
    return { ...result, created: false };
  }

  private async ensureGitHubRepo(auth: StoredGitHubAuth, repo: string, description: string): Promise<GitHubRepository> {
    const existing = await this.findGitHubRepo(auth.token, repo);
    if (existing) return existing;
    const [owner, name] = repo.split("/");
    if (owner?.toLowerCase() !== auth.username.toLowerCase()) {
      throw new Error("Create the destination repository in the selected account or organization first.");
    }
    const response = await this.githubRequest("/user/repos", auth.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, private: false, auto_init: false }),
    });
    if (!response.ok) {
      throw new Error(`Could not create GitHub repository '${repo}' (HTTP ${response.status}).`);
    }
    const result = await response.json() as GitHubRepository;
    if (result.full_name?.toLowerCase() !== repo.toLowerCase()) {
      throw new Error("GitHub created a repository other than the reviewed destination. Inspect it before retrying.");
    }
    return { ...result, created: true };
  }

  async preparePackage(params: PublishPackageParams): Promise<PackagePrepareResult> {
    await this.cleanupLegacyGitPublish();
    const ownerAccount = validateOwnerAccount(params.ownerAccount);
    const sources = await this.listSources();
    const source = sources.find((row) => row.sourceId === params.sourceId);
    if (!source) throw new Error(`Unknown sourceId '${params.sourceId}'`);

    let buildId: string | undefined;
    if (!params.skipBuild && source.hasPackageJson) {
      if (!source.buildGranted) await this.requestBuild(source.sourceId);
      const build = await this.callHostJob<HostBuildReport>("package.build", { source_id: source.sourceId });
      if (!build.ok || !build.build_id) {
        const detail = build.steps?.find((step) => !step.ok)?.detail || build.failed_step || "build step failed";
        throw new Error(`Build failed: ${detail}`);
      }
      buildId = build.build_id;
    }

    const preparedId = randomUUID();
    const output = `packages/${preparedId}.surface`;
    const packed = await this.callHostJob<HostPackageReport>("package.pack", {
      ...(buildId ? { build_id: buildId } : { source_id: source.sourceId }), output,
    });
    const archiveScan = mapScan(packed.scan ?? await this.callHostJob<HostScanReport>(
      "package.scan_secrets", { package_path: output },
    ));
    if (packed.metadata.id !== source.id || archiveScan.targetDigest !== packed.sha256) {
      throw new Error("Prepared package identity or file digest changed. Prepare it again.");
    }
    const version = packed.metadata.version;
    const tag = params.tag?.trim() || `v${version}`;
    const { slug, auth } = await this.resolveRepoSlug(params.repo, source.id);
    const existing = auth ? await this.findGitHubRepo(auth.token, slug) : null;
    const distribution = await this.callHostJob<HostGitPrepareReport>("git.prepare_publication", {
      source_id: source.sourceId,
      kind: "distribution",
      repo: slug,
      branch: existing?.default_branch || "main",
      owner_account: ownerAccount,
      message: `Publish ${source.id} ${tag} distribution metadata`,
      github_token: auth?.token,
      author_name: auth?.username,
      author_email: auth ? `${auth.username}@users.noreply.github.com` : undefined,
    });
    const distributionScan = mapScan(distribution.scan);
    const blocked = archiveScan.blocked || distributionScan.blocked;
    const scan = {
      ...archiveScan,
      clean: archiveScan.clean && distributionScan.clean,
      blocked,
      requiresReview: !blocked && (archiveScan.requiresReview || distributionScan.requiresReview),
      findings: [...archiveScan.findings, ...distributionScan.findings],
      scannedFiles: archiveScan.scannedFiles + distributionScan.scannedFiles,
    };
    const { target, minimum_host_version: minimumHostVersion } = packed.metadata.spec;
    const result: PackagePrepareResult = {
      ok: true, mode: "use_only", preparedId, surfaceId: source.id,
      version, repo: slug, tag, packagePath: packed.path, archiveSha256: packed.sha256,
      archiveBytes: packed.archive_bytes, bundleDigest: packed.metadata.bundle_digest,
      compatibility: {
        target,
        platform: packed.target_label ?? (target === "any" ? "All Ponpoko platforms" : target),
        minimumHostVersion,
      },
      filesCount: packed.metadata.files.length, excluded: scan.excluded, scan, consentPrompt: slug,
      distribution: { commit: distribution.commit, branch: distribution.branch, files: distribution.preview.files },
    };
    await this.savePreparation({ sourceId: source.sourceId, result, distribution, notes: params.notes?.trim() });
    return result;
  }

  private async releasePackage(prepared: PackagePrepareResult, targetCommit: string, notes: string | undefined, archive: Uint8Array<ArrayBuffer>, token: string): Promise<string> {
    const releases = `/repos/${prepared.repo}/releases`;
    const compatibility = prepared.compatibility;
    const requirements = compatibility
      ? `Package for ${compatibility.platform}. Requires Ponpoko ${compatibility.minimumHostVersion} or later.`
      : "";
    const body = [requirements, notes || `Bundle digest: ${prepared.bundleDigest}\nArchive SHA-256: ${prepared.archiveSha256}`].filter(Boolean).join("\n\n");
    const create = await this.githubRequest(releases, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: prepared.tag, target_commitish: targetCommit,
        name: `${prepared.surfaceId} ${prepared.tag}`,
        body,
        draft: true, prerelease: prepared.version.split("+")[0].includes("-"),
      }),
    }).catch(() => { throw new Error(`Draft creation outcome is unknown. Inspect ${prepared.repo} at ${prepared.tag} before retrying.`); });
    if (!create.ok) throw new Error(`GitHub draft release creation failed (HTTP ${create.status}). Inspect ${prepared.repo} at ${prepared.tag} before retrying.`);
    const draft = await create.json().catch(() => null) as GitHubRelease | null;
    if (!draft || !Number.isSafeInteger(draft.id) || draft.id < 1 || draft.draft !== true) {
      throw new Error(`GitHub did not confirm a draft release. Inspect ${prepared.repo} at ${prepared.tag} before retrying.`);
    }
    const release = `${releases}/${draft.id}`;
    try {
      const upload = new URL(draft.upload_url.split("{")[0]);
      if (upload.origin !== "https://uploads.github.com" || upload.username || upload.password ||
          upload.pathname.toLowerCase() !== `/repos/${prepared.repo}/releases/${draft.id}/assets`.toLowerCase()) {
        throw new Error("GitHub returned an unexpected release upload destination.");
      }
      const targetSuffix = compatibility ? `-${compatibility.target}` : "";
      upload.searchParams.set("name", `${prepared.surfaceId}-${prepared.version}${targetSuffix}.surface`);
      const response = await this.fetchImpl(upload.toString(), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: archive,
      });
      if (!response.ok) throw new Error(`Uploading .surface asset failed (HTTP ${response.status}).`);
      const asset = await response.json() as { state?: string; digest?: string; size?: number };
      if (asset.state !== "uploaded" || asset.digest !== `sha256:${prepared.archiveSha256}` || asset.size !== archive.byteLength) {
        throw new Error("GitHub did not verify the reviewed archive bytes.");
      }
    } catch (error) {
      const current = await this.readRelease(release, token);
      const removed = current?.id === draft.id && current.draft === true && (await this.githubRequest(release, token, { method: "DELETE" })
        .catch(() => null))?.ok === true;
      const result = removed ? "The draft was removed." : `Inspect GitHub release ${draft.id} before retrying.`;
      throw new Error(`${redactSecret(error instanceof Error ? error.message : String(error), token)} ${result}`);
    }

    const published = await this.githubRequest(release, token, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: false }),
    }).then(async response => response.ok ? await response.json() as GitHubRelease : null).catch(() => null);
    const current = published?.draft === false && published.immutable === true ? published : await this.readRelease(release, token);
    if (current?.id === draft.id && current.draft === false && current.immutable === true &&
        current.tag_name === prepared.tag && current.html_url) {
      const commit = await this.readTagCommit(prepared.repo, prepared.tag, token).catch(() => null);
      if (commit === targetCommit) return current.html_url;
      throw new Error(`GitHub did not confirm the reviewed tag commit. Inspect release ${draft.id} before retrying.`);
    }
    throw new Error(`GitHub did not confirm an immutable release. Inspect ${prepared.repo} release ${draft.id} before retrying.`);
  }

  private async readRelease(path: string, token: string): Promise<GitHubRelease | null> {
    return this.githubRequest(path, token).then(async response => response.ok ? await response.json() as GitHubRelease : null)
      .catch(() => null);
  }

  private async readTagCommit(repo: string, tag: string, token: string): Promise<string | null> {
    let path = `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
    for (let depth = 0; depth < 5; depth++) {
      const response = await this.githubRequest(path, token);
      if (!response.ok) return null;
      const { object } = await response.json() as { object?: { type: string; sha: string } };
      if (!object || !/^[a-f0-9]{40}$/.test(object.sha)) return null;
      if (object.type === "commit") return object.sha;
      if (object.type !== "tag") return null;
      path = `/repos/${repo}/git/tags/${object.sha}`;
    }
    return null;
  }

  async publishPackage(params: PublishPackageParams): Promise<PublishPackageResult> {
    const saved = await this.loadPreparation(params.preparedId, params.sourceId);
    if (!("distribution" in saved)) throw new Error("Prepare a package for this publication.");
    const { result: prepared, distribution, notes } = saved;
    if (prepared.scan.blocked) throw new Error("Security scan blocked publication.");
    const result = {
      ok: true, mode: "use_only" as const, dryRun: Boolean(params.dryRun), surfaceId: prepared.surfaceId,
      version: prepared.version, repo: prepared.repo, tag: prepared.tag, packagePath: prepared.packagePath,
      bundleDigest: prepared.bundleDigest, archiveSha256: prepared.archiveSha256,
      compatibility: prepared.compatibility,
      filesCount: prepared.filesCount, excluded: prepared.excluded,
    };
    if (params.dryRun) {
      return { ...result, releaseUrl: `https://github.com/${prepared.repo}/releases/tag/${prepared.tag}` };
    }

    verifyReviewAndRemote(prepared.scan, params.confirmRemote, prepared.repo, prepared.tag, params.approval);
    if (params.approval?.distributionDigest !== distribution.commit) {
      throw new Error("The distribution commit needs explicit review confirmation.");
    }
    const archive = await readFile(prepared.packagePath);
    if (archive.length !== prepared.archiveBytes || createHash("sha256").update(archive).digest("hex") !== prepared.archiveSha256) {
      throw new Error("The archive changed after review. Prepare and review it again.");
    }
    const auth = await this.activeToken();
    const repo = await this.ensureGitHubRepo(auth, prepared.repo, `${prepared.surfaceId} for Ponpoko`);
    if ((repo.default_branch || "main") !== distribution.branch) {
      throw new Error("The default branch changed after review. Prepare and review it again.");
    }
    const immutablePath = `/repos/${prepared.repo}/immutable-releases`;
    const immutable = await this.githubRequest(immutablePath, auth.token);
    if (immutable.status === 404 && repo.created) {
      const enabled = await this.githubRequest(immutablePath, auth.token, { method: "PUT" });
      if (!enabled.ok) throw new Error("Could not enable immutable releases on the new repository.");
    } else if (!immutable.ok) {
      throw new Error("Enable immutable releases in the destination repository before publishing.");
    }
    const tag = await this.githubRequest(`/repos/${prepared.repo}/git/ref/tags/${encodeURIComponent(prepared.tag)}`, auth.token);
    if (tag.ok) throw new Error(`Tag '${prepared.tag}' already exists on ${prepared.repo}. Bump the version before publishing an update.`);
    if (tag.status !== 404) throw new Error(`Could not verify the release tag (HTTP ${tag.status}).`);
    await this.pushReviewedCommit(distribution.staging_id, prepared.repo, distribution.branch,
      distribution.commit, params.approval.acknowledgedWarnings, auth.token);
    const releaseUrl = await this.releasePackage(prepared, distribution.commit, notes, archive, auth.token)
      .catch((error: unknown) => {
        throw new Error(`Distribution commit ${distribution.commit} was pushed. ${error instanceof Error ? error.message : String(error)}`);
      });
    return { ...result, releaseUrl };
  }

  private async pushReviewedCommit(stagingId: string, repo: string, branch: string, commit: string, warnings: boolean, token: string) {
    const pushed = await this.callHostJob<HostGitPushReport>("git.push_publication", {
      staging_id: stagingId, confirm_remote: repo, expected_remote: repo, github_token: token,
      approval: { digest: commit, remote: repo, target_ref: branch, acknowledged_warnings: warnings },
    });
    if (!pushed.pushed) throw new Error(redactSecret(pushed.detail || "Git push failed", token));
  }

  async prepareSource(params: PublishSourceParams): Promise<SourcePrepareResult> {
    await this.cleanupLegacyGitPublish();
    const ownerAccount = validateOwnerAccount(params.ownerAccount);
    const sources = await this.listSources();
    const source = sources.find((row) => row.sourceId === params.sourceId);
    if (!source) throw new Error(`Unknown sourceId '${params.sourceId}'`);
    const branch = params.branch?.trim() || "main";
    const { slug, auth } = await this.resolveRepoSlug(params.repo, source.id);
    const prepared = await this.callHostJob<HostGitPrepareReport>("git.prepare_publication", {
      source_id: source.sourceId, kind: "source", repo: slug, branch, owner_account: ownerAccount,
      message: params.message?.trim() || undefined, github_token: auth?.token,
      author_name: auth?.username,
      author_email: auth ? `${auth.username}@users.noreply.github.com` : undefined,
    });
    const result: SourcePrepareResult = {
      ok: true, mode: "open_source", preparedId: randomUUID(), surfaceId: source.id,
      repo: prepared.repo, branch: prepared.branch, stagingId: prepared.staging_id, commit: prepared.commit,
      filesCount: prepared.files_count, excluded: prepared.excluded, scan: mapScan(prepared.scan),
      preview: {
        commits: prepared.preview.commits, files: prepared.preview.files, remoteSlug: prepared.preview.remote_slug,
        consent: prepared.preview.consent, blocked: prepared.preview.blocked,
      },
    };
    await this.savePreparation({ sourceId: source.sourceId, result });
    return result;
  }

  async publishSource(params: PublishSourceParams): Promise<PublishSourceResult> {
    const saved = await this.loadPreparation(params.preparedId, params.sourceId);
    if ("distribution" in saved) throw new Error("Prepare a source commit for this publication.");
    const prepared = saved.result;
    if (prepared.scan.blocked) throw new Error("Security scan blocked publication.");
    const result = {
      ok: true, mode: "open_source" as const, dryRun: Boolean(params.dryRun), surfaceId: prepared.surfaceId,
      repo: prepared.repo, branch: prepared.branch, commit: prepared.commit, excluded: prepared.excluded,
      filesCount: prepared.filesCount,
    };
    if (params.dryRun) return { ...result, repoUrl: `https://github.com/${prepared.repo}` };
    verifyReviewAndRemote(prepared.scan, params.confirmRemote, prepared.repo, prepared.branch, params.approval);
    const auth = await this.activeToken();
    const repo = await this.ensureGitHubRepo(auth, prepared.repo, `${prepared.surfaceId} for Ponpoko`);
    await this.pushReviewedCommit(prepared.stagingId, prepared.repo, prepared.branch, prepared.commit,
      params.approval?.acknowledgedWarnings === true, auth.token);
    return { ...result, repoUrl: repo.html_url };
  }
}

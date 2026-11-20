import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PublishPackageParams,
  PublishPackageResult,
  PublishSourceParams,
  PublishSourceResult,
  SecurityFinding,
  SecurityScanResult,
} from "../shared/types";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "target", ".ponpoko", ".turbo", ".cache"]);
const PACKAGE_EXCLUDE_PATTERNS = [
  /^node_modules(\/|$)/,
  /^\.git(\/|$)/,
  /^\.ponpoko(\/|$)/,
  /^\.env($|\.)/,
  /\.sqlite3?(-wal|-shm)?$/i,
  /\.log$/i,
  /^\.DS_Store$/,
];

export interface HostControlEndpoint {
  protocol?: number;
  url?: string;
  token?: string;
}

export interface PublisherOptions {
  dataDir: string;
  sourceRoots?: string[];
  hostDbPath?: string;
  hostControlPath?: string;
  surfaceId?: string;
  fetchImpl?: typeof fetch;
  disableGhCli?: boolean;
}

interface HostScanReport {
  clean: boolean;
  scanned_files: number;
  findings: SecurityFinding[];
  excluded: string[];
}

interface HostBuildReport {
  ok: boolean;
  failed_step?: string | null;
  bundle_root: string;
  steps?: Array<{ step: string; ok: boolean; detail: string }>;
}

interface HostPackageReport {
  path: string;
  sha256: string;
  archive_bytes: number;
  metadata: {
    id: string;
    version: string;
    bundle_digest: string;
    files: Array<{ path: string; bytes: number; sha256: string; executable: boolean }>;
  };
}

interface StoredGitHubAuth {
  token: string;
  username: string;
}

function isExcludedPath(relPath: string): boolean {
  return PACKAGE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(relPath))
    || relPath.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  root: string,
  current = root,
  out: Array<{ abs: string; rel: string; size: number; mode: number }> = [],
  excluded: string[] = [],
): Promise<{ files: Array<{ abs: string; rel: string; size: number; mode: number }>; excluded: string[] }> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(current, entry.name);
    const rel = relative(root, abs).split("\\").join("/");
    if (entry.isSymbolicLink()) {
      excluded.push(rel);
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        excluded.push(`${rel}/`);
        continue;
      }
      await walkFiles(root, abs, out, excluded);
      continue;
    }
    if (isExcludedPath(rel)) {
      excluded.push(rel);
      continue;
    }
    const info = await stat(abs);
    out.push({ abs, rel, size: info.size, mode: info.mode });
  }
  return { files: out, excluded };
}

export class PublisherService {
  private readonly dataDir: string;
  private readonly sourceRoots: string[];
  private readonly hostDbPath: string | null;
  private readonly hostControlPath: string | null;
  private readonly surfaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly disableGhCli: boolean;

  constructor(options: PublisherOptions) {
    this.dataDir = resolve(options.dataDir);
    const envRoots = process.env.PONPOKO_SOURCES_DIR
      ? process.env.PONPOKO_SOURCES_DIR.split(":").map((item) => item.trim()).filter(Boolean)
      : null;
    this.sourceRoots = options.sourceRoots ?? envRoots ?? [join(homedir(), "ponpoko-surfaces")];
    this.hostDbPath = options.hostDbPath ?? process.env.PONPOKO_HOST_DATABASE ?? null;
    this.hostControlPath = options.hostControlPath ?? process.env.PONPOKO_HOST_CONTROL ?? null;
    this.surfaceId = options.surfaceId ?? process.env.PONPOKO_SURFACE_ID ?? "surface-publisher";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.disableGhCli = options.disableGhCli ?? false;
  }

  private async callHostRuntime<T>(operation: string, extra: Record<string, unknown>): Promise<T> {
    if (!this.hostControlPath) {
      throw new Error("Host control endpoint (PONPOKO_HOST_CONTROL) is required to build, scan, or pack surfaces.");
    }
    const endpoint = JSON.parse(await readFile(this.hostControlPath, "utf8")) as HostControlEndpoint;
    if (endpoint.protocol !== 1 || !endpoint.url || !endpoint.token) {
      throw new Error("Invalid Host control endpoint configuration.");
    }
    const response = await this.fetchImpl(endpoint.url, {
      method: "POST",
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

  private authPath(): string {
    return join(this.dataDir, "github-auth.json");
  }

  private async readStoredAuth(): Promise<StoredGitHubAuth | null> {
    try {
      const raw = await readFile(this.authPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredGitHubAuth>;
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

  private async discoverDbSourcePaths(): Promise<string[]> {
    if (!this.hostDbPath || !(await exists(this.hostDbPath))) return [];
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(this.hostDbPath, { readonly: true });
      try {
        const rows = db.query("SELECT origin_json FROM surface_install").all() as Array<{ origin_json?: string }>;
        const paths: string[] = [];
        for (const row of rows) {
          if (!row.origin_json) continue;
          const parsed = JSON.parse(row.origin_json) as {
            editable_source?: string;
            source?: string;
            kind?: string;
          };
          const candidate = parsed.editable_source ?? parsed.source;
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            paths.push(candidate.trim());
          }
        }
        return paths;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  async listSources(rootsOverride?: string[]): Promise<LocalSurfaceSource[]> {
    const candidateDirs = new Set<string>();
    const roots = rootsOverride && rootsOverride.length > 0 ? rootsOverride : this.sourceRoots;
    for (const root of roots) {
      if (!(await exists(root))) continue;
      if (await exists(join(root, "surface.json"))) {
        candidateDirs.add(resolve(root));
        continue;
      }
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        if (await exists(join(dir, "surface.json"))) {
          candidateDirs.add(resolve(dir));
        }
      }
    }
    if (!rootsOverride) {
      for (const dbDir of await this.discoverDbSourcePaths()) {
        if (await exists(join(dbDir, "surface.json"))) {
          candidateDirs.add(resolve(dbDir));
        }
      }
    }

    const sources: LocalSurfaceSource[] = [];
    for (const dir of candidateDirs) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, "surface.json"), "utf8")) as {
          id?: string;
          name?: string;
          version?: string;
          description?: string;
        };
        if (!manifest.id || manifest.id === "surface-publisher") continue;
        sources.push({
          id: manifest.id,
          name: manifest.name ?? manifest.id,
          version: manifest.version ?? "0.1.0",
          description: manifest.description ?? "",
          path: dir,
          hasGit: await exists(join(dir, ".git")),
          hasPackageJson: await exists(join(dir, "package.json")),
        });
      } catch {
        continue;
      }
    }
    return sources.sort((a, b) => a.name.localeCompare(b.name));
  }

  async scanSecurity(surfacePath: string): Promise<SecurityScanResult> {
    const root = resolve(surfacePath);
    if (!(await exists(join(root, "surface.json")))) {
      throw new Error(`surface.json not found at ${root}`);
    }
    const report = await this.callHostRuntime<HostScanReport>("package.scan_secrets", { path: root });
    return {
      clean: report.clean,
      scannedFiles: report.scanned_files,
      findings: report.findings,
      excluded: report.excluded,
    };
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

  async githubConnect(token: string, usernameOverride?: string): Promise<GitHubStatus> {
    const clean = token.trim();
    if (!clean) throw new Error("GitHub token is required");
    let username = usernameOverride?.trim() ?? "";
    if (!username) {
      const response = await this.fetchImpl("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${clean}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ponpoko-surface-publisher",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub authentication failed (${response.status})`);
      }
      const user = (await response.json()) as { login?: string };
      username = user.login ?? "github-user";
    }
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.authPath(), JSON.stringify({ token: clean, username }, null, 2), { mode: 0o600 });
    await chmod(this.authPath(), 0o600);
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
      const resp = await this.fetchImpl("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${cli}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ponpoko-surface-publisher",
        },
      });
      const user = resp.ok ? ((await resp.json()) as { login?: string }) : {};
      return { token: cli, username: user.login ?? "github-user" };
    }
    throw new Error("Please connect your GitHub account before publishing");
  }

  private async ensureGitHubRepo(token: string, repoSlug: string, description: string): Promise<{ html_url: string; full_name: string }> {
    const check = await this.fetchImpl(`https://api.github.com/repos/${repoSlug}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ponpoko-surface-publisher",
      },
    });
    if (check.ok) {
      return (await check.json()) as { html_url: string; full_name: string };
    }
    const repoName = repoSlug.includes("/") ? repoSlug.split("/")[1] : repoSlug;
    const create = await this.fetchImpl("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ponpoko-surface-publisher",
      },
      body: JSON.stringify({
        name: repoName,
        description,
        private: false,
        auto_init: false,
      }),
    });
    if (!create.ok) {
      const errText = await create.text();
      throw new Error(`Could not create GitHub repository '${repoSlug}': ${create.status} ${errText}`);
    }
    return (await create.json()) as { html_url: string; full_name: string };
  }

  async publishPackage(params: PublishPackageParams): Promise<PublishPackageResult> {
    const root = resolve(params.path);
    const scan = await this.scanSecurity(root);
    if (!scan.clean) {
      const details = scan.findings.map((f) => `${f.path}: ${f.reason}`).join("; ");
      throw new Error(`Security scan blocked publication: ${details}`);
    }

    const manifest = JSON.parse(await readFile(join(root, "surface.json"), "utf8")) as {
      id: string;
      name?: string;
      version?: string;
      description?: string;
    };
    const surfaceId = manifest.id;
    const version = manifest.version ?? "0.1.0";
    const tag = params.tag?.trim() || `v${version}`;

    let bundleSourceDir = root;
    if (!params.skipBuild && (await exists(join(root, "package.json")))) {
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) {
        const build = await this.callHostRuntime<HostBuildReport>("package.build", { path: root });
        if (!build.ok) {
          const detail = build.steps?.find((step) => !step.ok)?.detail || build.failed_step || "build step failed";
          throw new Error(`Build failed: ${detail}`);
        }
        bundleSourceDir = build.bundle_root;
      }
    } else if (await exists(join(root, "dist", "surface.json"))) {
      bundleSourceDir = join(root, "dist");
    }

    const archiveDir = join(this.dataDir, "packages");
    await mkdir(archiveDir, { recursive: true });
    const packagePath = join(archiveDir, `${surfaceId}-${version}.surface`);
    await rm(packagePath, { force: true });

    const packed = await this.callHostRuntime<HostPackageReport>("package.pack", {
      bundle: bundleSourceDir,
      output: packagePath,
    });
    const bundleDigest = packed.metadata.bundle_digest;
    const filesCount = packed.metadata.files.length;

    const repoSlug = params.repo?.trim() || `local/${surfaceId}`;
    if (params.dryRun) {
      return {
        ok: true,
        mode: "use_only",
        dryRun: true,
        surfaceId,
        version,
        repo: repoSlug,
        tag,
        packagePath: packed.path,
        bundleDigest,
        filesCount,
        excluded: scan.excluded,
        releaseUrl: `https://github.com/${repoSlug}/releases/tag/${tag}`,
      };
    }

    const auth = await this.activeToken();
    const resolvedRepo = params.repo?.trim().includes("/")
      ? params.repo.trim()
      : `${auth.username}/${params.repo?.trim() || `ponpoko-${surfaceId}`}`;
    await this.ensureGitHubRepo(auth.token, resolvedRepo, manifest.description ?? `${manifest.name ?? surfaceId} for Ponpoko`);

    const releaseResp = await this.fetchImpl(`https://api.github.com/repos/${resolvedRepo}/releases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ponpoko-surface-publisher",
      },
      body: JSON.stringify({
        tag_name: tag,
        name: `${manifest.name ?? surfaceId} ${tag}`,
        body: params.notes?.trim() || `Published with Ponpoko Publisher.\n\nbundle_digest: ${bundleDigest}`,
        draft: false,
        prerelease: false,
      }),
    });
    if (!releaseResp.ok) {
      throw new Error(`GitHub Release creation failed: ${releaseResp.status} ${await releaseResp.text()}`);
    }
    const release = (await releaseResp.json()) as { upload_url: string; html_url: string };
    const uploadBase = release.upload_url.split("{")[0];
    const archiveBytes = await readFile(packed.path);
    const assetName = `${surfaceId}-${version}.surface`;
    const uploadResp = await this.fetchImpl(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/octet-stream",
        "User-Agent": "ponpoko-surface-publisher",
      },
      body: archiveBytes,
    });
    if (!uploadResp.ok) {
      throw new Error(`Uploading .surface asset failed: ${uploadResp.status} ${await uploadResp.text()}`);
    }

    return {
      ok: true,
      mode: "use_only",
      dryRun: false,
      surfaceId,
      version,
      repo: resolvedRepo,
      tag,
      packagePath: packed.path,
      bundleDigest,
      filesCount,
      excluded: scan.excluded,
      releaseUrl: release.html_url,
    };
  }

  async publishSource(params: PublishSourceParams): Promise<PublishSourceResult> {
    const root = resolve(params.path);
    const scan = await this.scanSecurity(root);
    if (!scan.clean) {
      const details = scan.findings.map((f) => `${f.path}: ${f.reason}`).join("; ");
      throw new Error(`Security scan blocked publication: ${details}`);
    }

    const manifest = JSON.parse(await readFile(join(root, "surface.json"), "utf8")) as {
      id: string;
      name?: string;
      description?: string;
    };
    const surfaceId = manifest.id;
    const branch = params.branch?.trim() || "main";
    const { files } = await walkFiles(root);
    const repoSlug = params.repo?.trim() || `local/${surfaceId}`;

    if (params.dryRun) {
      return {
        ok: true,
        mode: "open_source",
        dryRun: true,
        surfaceId,
        repo: repoSlug,
        branch,
        commit: null,
        repoUrl: `https://github.com/${repoSlug}`,
        excluded: scan.excluded,
        filesCount: files.length,
      };
    }

    const auth = await this.activeToken();
    const resolvedRepo = params.repo?.trim().includes("/")
      ? params.repo.trim()
      : `${auth.username}/${params.repo?.trim() || `ponpoko-${surfaceId}`}`;
    const repoInfo = await this.ensureGitHubRepo(
      auth.token,
      resolvedRepo,
      manifest.description ?? `${manifest.name ?? surfaceId} for Ponpoko`,
    );

    const workDir = join(this.dataDir, "git-publish", surfaceId);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    for (const file of files) {
      const dest = join(workDir, file.rel);
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(file.abs, dest);
    }

    const gitignore = ["node_modules/", "dist/", ".ponpoko/", ".env", ".env.*", "*.sqlite", "*.sqlite3", "*.log", ".DS_Store"].join("\n");
    await writeFile(join(workDir, ".gitignore"), `${gitignore}\n`);
    if (params.ownerAccount) {
      await writeFile(join(workDir, "PONPOKO.md"), `---\nowner: ${params.ownerAccount}\n---\n`);
    }

    const runGit = (args: string[]) => {
      const res = Bun.spawnSync(["git", ...args], { cwd: workDir, stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(res.stderr)}`);
      }
      return new TextDecoder().decode(res.stdout).trim();
    };

    runGit(["init", "-b", branch]);
    runGit(["config", "user.name", auth.username]);
    runGit(["config", "user.email", `${auth.username}@users.noreply.github.com`]);
    runGit(["add", "."]);
    runGit(["commit", "-m", params.message?.trim() || `Publish ${surfaceId} via Ponpoko Publisher`]);
    const commit = runGit(["rev-parse", "HEAD"]);
    const remoteUrl = `https://x-access-token:${auth.token}@github.com/${resolvedRepo}.git`;
    runGit(["remote", "add", "origin", remoteUrl]);
    runGit(["push", "-u", "origin", branch]);

    return {
      ok: true,
      mode: "open_source",
      dryRun: false,
      surfaceId,
      repo: resolvedRepo,
      branch,
      commit,
      repoUrl: repoInfo.html_url,
      excluded: scan.excluded,
      filesCount: files.length,
    };
  }
}

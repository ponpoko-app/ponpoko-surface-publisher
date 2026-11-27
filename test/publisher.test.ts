import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PackagePrepareResult, SourcePrepareResult } from "../shared/types";
import { PublisherService } from "../backend/publisher";

const temps: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a linked auth file is ignored and connection verification never follows redirects", async () => {
  const dataDir = makeTempDir("publisher-auth-");
  const sentinel = join(dataDir, "sentinel.json");
  writeFileSync(sentinel, JSON.stringify({ token: "fixture-only", username: "wrong" }));
  symlinkSync(sentinel, join(dataDir, "github-auth.json"), "file");
  const fetchImpl = (async (url: string, options?: RequestInit) => {
    expect(url).toBe("https://api.github.com/user");
    expect(options?.redirect).toBe("error");
    return Response.json({ login: "verified" });
  }) as typeof fetch;
  const svc = new PublisherService({ dataDir, fetchImpl, disableGhCli: true });
  expect(await svc.githubStatus()).toMatchObject({ connected: false });
  expect(await svc.githubConnect("another-fixture")).toMatchObject({ username: "verified", connected: true });
  expect(JSON.parse(readFileSync(sentinel, "utf8")).username).toBe("wrong");
  expect(await svc.githubStatus()).toMatchObject({ username: "verified" });
});

function mockHostJobs(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1") return fetchImpl(input, init);
    const request = JSON.parse(String(init?.body));
    expect(request.extra.operation).toBe("jobs.start");
    request.extra = { operation: request.extra.job_operation, ...request.extra.input };
    const response = await fetchImpl(input, { ...init, body: JSON.stringify(request) });
    const answer = await response.json();
    return Response.json(answer.ok
      ? { ok: true, snapshot: { state: "completed", result: answer.snapshot } }
      : { ok: true, snapshot: { state: "failed", error: answer.error } });
  }) as typeof fetch;
}

function approve(prepared: PackagePrepareResult | SourcePrepareResult) {
  return {
    preparedId: prepared.preparedId,
    confirmRemote: prepared.repo,
    approval: {
      digest: prepared.scan.targetDigest,
      remote: prepared.repo,
      targetRef: prepared.mode === "use_only" ? prepared.tag : prepared.branch,
      distributionDigest: prepared.mode === "use_only" ? prepared.distribution.commit : undefined,
      acknowledgedWarnings: true,
    },
  };
}

describe("surface-publisher backend", () => {
  test("registers the picked folder through a Host job and polls the same request", async () => {
    const dataDir = makeTempDir("pub-source-picker-");
    const controlPath = join(dataDir, "host-control.json");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "test" }));
    let requestId: string | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { extra } = JSON.parse(String(init?.body));
      if (extra.operation === "jobs.start") {
        expect(extra.job_operation).toBe("sources.pick");
        requestId = extra.request_id;
        return Response.json({ ok: true, snapshot: { state: "running" } });
      }
      expect(extra.operation).toBe("jobs.status");
      expect(extra.request_id).toBe(requestId);
      return Response.json({ ok: true, snapshot: { state: "completed", result: { source_id: "src_picked" } } });
    }) as typeof fetch;
    const svc = new PublisherService({ dataDir, hostControlPath: controlPath, fetchImpl, disableGhCli: true });
    expect(await svc.pickSource()).toBe("src_picked");
  });

  test("lists Host sources by sourceId including drafts and pre-install registered sources without filtering by name", async () => {
    const dataDir = makeTempDir("pub-data-");
    const controlPath = join(dataDir, "host-control.json");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { extra: { operation: string } };
      expect(payload.extra.operation).toBe("sources.list");
      return Response.json({
        ok: true,
        snapshot: [
          {
            source_id: "src_111",
            id: "habit-tracker",
            name: "Habit Tracker",
            version: "0.1.0",
            description: "V1",
            status: "installed",
            revision: { version: "0.1.0", source_digest: "aaa", git_head: null },
            has_git: false,
            has_package_json: false,
            build_granted: false,
          },
          {
            source_id: "src_222",
            id: "habit-tracker",
            name: "Habit Tracker",
            version: "0.1.1",
            description: "Round 2 draft",
            status: "draft",
            revision: { version: "0.1.1", source_digest: "bbb", git_head: null },
            has_git: false,
            has_package_json: true,
            build_granted: true,
          },
          {
            source_id: "src_333",
            id: "surface-publisher",
            name: "Publisher",
            version: "1.0.0",
            description: "Self",
            status: "installed",
            revision: { version: "1.0.0", source_digest: "ccc", git_head: null },
            has_git: false,
            has_package_json: true,
            build_granted: false,
          },
        ],
      });
    }) as typeof fetch;

    const svc = new PublisherService({ dataDir, hostControlPath: controlPath, fetchImpl: mockHostJobs(fetchImpl), disableGhCli: true });
    const list = await svc.listSources();
    expect(list).toHaveLength(3);
    expect(list[1].sourceId).toBe("src_222");
    expect(list[1].status).toBe("draft");
    expect(list[2].id).toBe("surface-publisher");
  });

  test("first-time publishPackage creates draft, uploads .surface, publishes immutable release, and rolls back on mid-way upload failure", async () => {
    const dataDir = makeTempDir("pub-pkg-");
    const controlPath = join(dataDir, "host-control.json");
    const archivePath = join(dataDir, "timer-1.2.3.surface");
    const archive = "SURFACE_ARCHIVE_BYTES";
    writeFileSync(archivePath, archive);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    const noHost = new PublisherService({ dataDir, disableGhCli: true });
    await expect(noHost.scanSecurity("src_1")).rejects.toThrow("PONPOKO_HOST_CONTROL");

    let failUpload = false;
    const ghCalls: string[] = [];
    let repoExists = false;
    let immutableEnabled = false;
    let published = false;
    const commit = "a".repeat(40);

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "http://127.0.0.1:43210/") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { extra: { operation: string } };
        const op = payload.extra.operation;
        if (op === "sources.list") {
          return Response.json({
            ok: true,
            snapshot: [
              {
                source_id: "src_timer",
                id: "timer",
                name: "Timer",
                version: "1.2.3",
                description: "Timer",
                status: "installed",
                revision: { version: "1.2.3", source_digest: "src_sha", git_head: null },
                has_git: false,
                has_package_json: false,
                build_granted: false,
              },
            ],
          });
        }
        if (op === "package.pack") {
          return Response.json({
            ok: true,
            snapshot: {
              path: archivePath,
              sha256,
              archive_bytes: archive.length,
              target_label: "Mac (Apple Silicon)",
              metadata: {
                id: "timer",
                version: "1.2.3",
                spec: { target: "darwin-aarch64", minimum_host_version: "0.20.2" },
                bundle_digest: "bundle_sha_123",
                files: [{ path: "index.html", bytes: 20, sha256: "f1", executable: false }],
              },
              scan: {
                clean: true,
                blocked: false,
                requires_review: false,
                target_digest: sha256,
                scanned_files: 1,
                findings: [],
                excluded: [],
              },
            },
          });
        }
        if (op === "git.prepare_publication") {
          return Response.json({
            ok: true,
            snapshot: {
              staging_id: "stg-1",
              commit: commit,
              repo: "alice/ponpoko-timer",
              branch: "main",
              files_count: 2,
              excluded: [],
              scan: {
                clean: true,
                blocked: false,
                requires_review: false,
                target_digest: commit,
                scanned_files: 2,
                findings: [],
                excluded: [],
              },
              preview: { commits: 1, files: [], remote_slug: "alice/ponpoko-timer", consent: "alice/ponpoko-timer", blocked: null },
            },
          });
        }
        if (op === "git.push_publication") {
          return Response.json({
            ok: true,
            snapshot: { pushed: true, branch: "main", remote: "https://github.com/alice/ponpoko-timer.git", detail: "ok" },
          });
        }
      }

      ghCalls.push(`${method} ${url}`);
      if (url === "https://api.github.com/user") {
        return Response.json({ login: "alice" });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer" && method === "GET") {
        return repoExists
          ? Response.json({ html_url: "https://github.com/alice/ponpoko-timer", full_name: "alice/ponpoko-timer", default_branch: "main" })
          : new Response("Not Found", { status: 404 });
      }
      if (url === "https://api.github.com/user/repos" && method === "POST") {
        repoExists = true;
        return Response.json({ html_url: "https://github.com/alice/ponpoko-timer", full_name: "alice/ponpoko-timer", default_branch: "main" });
      }
      if (url.endsWith("/immutable-releases")) {
        if (method === "PUT") { immutableEnabled = true; return new Response(null, { status: 204 }); }
        return immutableEnabled ? Response.json({ enabled: true }) : new Response(null, { status: 404 });
      }
      if (url.includes("/git/ref/tags/")) {
        return published ? Response.json({ object: { type: "commit", sha: commit } })
          : new Response("Not Found", { status: 404 });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { draft?: boolean; target_commitish?: string; body?: string };
        expect(body.draft).toBe(true);
        expect(body.target_commitish).toBe(commit);
        expect(body.body).toContain("Package for Mac (Apple Silicon). Requires Ponpoko 0.20.2 or later.");
        return Response.json({
          id: 99, draft: true,
          upload_url: "https://uploads.github.com/repos/alice/ponpoko-timer/releases/99/assets{?name,label}",
          html_url: "https://github.com/alice/ponpoko-timer/releases/tag/v1.2.3",
        });
      }
      if (url.startsWith("https://uploads.github.com/")) {
        expect(new URL(url).searchParams.get("name")).toBe("timer-1.2.3-darwin-aarch64.surface");
        if (failUpload) {
          return new Response("upload aborted for ghp_secret_token_leak", { status: 502 });
        }
        return Response.json({ id: 501, state: "uploaded", digest: `sha256:${sha256}`, size: archive.length });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases/99" && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { draft?: boolean };
        expect(body.draft).toBe(false);
        published = true;
        return Response.json({ id: 99, draft: false, immutable: true, tag_name: "v1.2.3", html_url: "https://github.com/alice/ponpoko-timer/releases/tag/v1.2.3" });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases/99" && method === "GET") {
        return Response.json({ id: 99, draft: true });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases/99" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const svc = new PublisherService({ dataDir, hostControlPath: controlPath, fetchImpl: mockHostJobs(fetchImpl), disableGhCli: true });
    await svc.githubConnect("ghp_secret_token_leak");

    const params = { sourceId: "src_timer", repo: "alice/ponpoko-timer", ownerAccount: "acct_alice" };
    const reviewed = await svc.preparePackage(params);
    expect(reviewed.compatibility).toEqual({ target: "darwin-aarch64", platform: "Mac (Apple Silicon)", minimumHostVersion: "0.20.2" });
    await expect(svc.publishPackage({
      ...params, ...approve(reviewed), approval: { ...approve(reviewed).approval, digest: "stale" },
    })).rejects.toThrow("explicit review");
    writeFileSync(archivePath, "ARCHIVE_CHANGED_AFTER_REVIEW");
    await expect(svc.publishPackage({ ...params, ...approve(reviewed) })).rejects.toThrow("archive changed");
    expect(ghCalls.some(call => call.startsWith("POST"))).toBe(false);
    writeFileSync(archivePath, archive);
    failUpload = true;
    const err = await svc.publishPackage({ ...params, ...approve(reviewed) })
      .catch((e: unknown) => String(e));
    expect(err).not.toContain("ghp_secret_token_leak");
    expect(ghCalls.some((c) => c.startsWith("DELETE https://api.github.com/repos/alice/ponpoko-timer/releases/99"))).toBe(true);
    expect(ghCalls.some((c) => c.startsWith("PATCH https://api.github.com/repos/alice/ponpoko-timer/releases/99"))).toBe(false);

    failUpload = false;
    const newReview = await svc.preparePackage(params);
    const ok = await svc.publishPackage({ ...params, ...approve(newReview) });
    expect(ok.ok).toBe(true);
    expect(immutableEnabled).toBe(true);
    expect(ok.releaseUrl).toBe("https://github.com/alice/ponpoko-timer/releases/tag/v1.2.3");
    expect(ghCalls.some((c) => c.startsWith("PATCH https://api.github.com/repos/alice/ponpoko-timer/releases/99"))).toBe(true);
  });

  test("credential_literal warning requires bound review matching digest, remote, and branch/tag while hard blocks are never bypassable", async () => {
    const dataDir = makeTempDir("pub-review-");
    const controlPath = join(dataDir, "host-control.json");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    let severity: "warning" | "block" = "warning";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://127.0.0.1:43210/") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { extra: { operation: string } };
        const op = payload.extra.operation;
        if (op === "sources.list") {
          return Response.json({
            ok: true,
            snapshot: [
              {
                source_id: "src_notes",
                id: "notes",
                name: "Notes",
                version: "0.1.0",
                description: "Notes",
                status: "installed",
                revision: { version: "0.1.0", source_digest: "s1", git_head: null },
                has_git: false,
                has_package_json: false,
                build_granted: false,
              },
            ],
          });
        }
        if (op === "git.prepare_publication") {
          return Response.json({
            ok: true,
            snapshot: {
              staging_id: "stg-2",
              commit: "commit_abc",
              repo: "alice/ponpoko-notes",
              branch: "main",
              files_count: 3,
              excluded: [],
              scan: {
                clean: false,
                blocked: severity === "block",
                requires_review: severity === "warning",
                target_digest: "commit_abc",
                scanned_files: 3,
                findings: [
                  {
                    path: "test/auth.test.ts",
                    rule_id: severity === "block" ? "provider_token" : "credential_literal",
                    severity,
                    reason: "matched",
                  },
                ],
                excluded: [],
              },
              preview: { commits: 1, files: [], remote_slug: "alice/ponpoko-notes", consent: "alice/ponpoko-notes", blocked: null },
            },
          });
        }
        if (op === "git.push_publication") {
          return Response.json({
            ok: true,
            snapshot: { pushed: true, branch: "main", remote: "https://github.com/alice/ponpoko-notes.git", detail: "ok" },
          });
        }
      }
      if (url === "https://api.github.com/user") return Response.json({ login: "alice" });
      if (url.startsWith("https://api.github.com/repos/")) {
        return Response.json({ html_url: "https://github.com/alice/ponpoko-notes", full_name: "alice/ponpoko-notes", default_branch: "main" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const svc = new PublisherService({ dataDir, hostControlPath: controlPath, fetchImpl: mockHostJobs(fetchImpl), disableGhCli: true });
    await svc.githubConnect("ghp_dummy_token_value_123456");

    const params = { sourceId: "src_notes", repo: "alice/ponpoko-notes" };
    const reviewed = await svc.prepareSource(params);
    await expect(svc.publishSource({
      ...params, ...approve(reviewed), approval: { ...approve(reviewed).approval, digest: "stale_commit" },
    })).rejects.toThrow("explicit review confirmation");

    severity = "block";
    const ok = await svc.publishSource({ ...params, ...approve(reviewed) });
    expect(ok.ok).toBe(true);

    const blocked = await svc.prepareSource(params);
    await expect(svc.publishSource({ ...params, ...approve(blocked) })).rejects.toThrow("blocked publication");

  });

  test("second-time publishPackage rejects duplicate tag and succeeds when bumped to v1.2.4", async () => {
    const dataDir = makeTempDir("pub-r2-");
    const controlPath = join(dataDir, "host-control.json");
    const archivePath = join(dataDir, "timer-1.2.4.surface");
    const archive = "SURFACE_V2";
    writeFileSync(archivePath, archive);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    let version = "1.2.3";
    let published = false;
    const commit = "b".repeat(40);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "http://127.0.0.1:43210/") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { extra: { operation: string } };
        const op = payload.extra.operation;
        if (op === "sources.list") {
          return Response.json({
            ok: true,
            snapshot: [
              {
                source_id: "src_timer_r2",
                id: "timer",
                name: "Timer",
                version,
                description: "Timer",
                status: "draft",
                revision: { version, source_digest: "s2", git_head: null },
                has_git: false,
                has_package_json: false,
                build_granted: false,
              },
            ],
          });
        }
        if (op === "package.pack") {
          return Response.json({
            ok: true,
            snapshot: {
              path: archivePath,
              sha256,
              archive_bytes: archive.length,
              metadata: {
                id: "timer",
                version,
                spec: { target: "any", minimum_host_version: "0.20.2" },
                bundle_digest: `b_${version}`,
                files: [{ path: "index.html", bytes: 10, sha256: "f1", executable: false }],
              },
              scan: {
                clean: true,
                blocked: false,
                requires_review: false,
                target_digest: sha256,
                scanned_files: 1,
                findings: [],
                excluded: [],
              },
            },
          });
        }
        if (op === "git.prepare_publication") {
          return Response.json({
            ok: true,
            snapshot: {
              staging_id: "stg-r2",
              commit: commit,
              repo: "alice/ponpoko-timer",
              branch: "main",
              files_count: 2,
              excluded: [],
              scan: {
                clean: true,
                blocked: false,
                requires_review: false,
                target_digest: commit,
                scanned_files: 2,
                findings: [],
                excluded: [],
              },
              preview: { commits: 2, files: [], remote_slug: "alice/ponpoko-timer", consent: "alice/ponpoko-timer", blocked: null },
            },
          });
        }
        if (op === "git.push_publication") {
          return Response.json({
            ok: true,
            snapshot: { pushed: true, branch: "main", remote: "https://github.com/alice/ponpoko-timer.git", detail: "fast-forward" },
          });
        }
      }
      if (url === "https://api.github.com/user") return Response.json({ login: "alice" });
      if (url === "https://api.github.com/repos/alice/ponpoko-timer" && method === "GET") {
        return Response.json({ html_url: "https://github.com/alice/ponpoko-timer", full_name: "alice/ponpoko-timer", default_branch: "main" });
      }
      if (url.endsWith("/immutable-releases")) return Response.json({ enabled: true });
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/git/ref/tags/v1.2.3") {
        return Response.json({ id: 10 });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/git/ref/tags/v1.2.4") {
        return published ? Response.json({ object: { type: "commit", sha: commit } })
          : new Response("Not Found", { status: 404 });
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases" && method === "POST") {
        return Response.json({
          id: 101, draft: true,
          upload_url: "https://uploads.github.com/repos/alice/ponpoko-timer/releases/101/assets{?name}",
          html_url: "https://github.com/alice/ponpoko-timer/releases/tag/v1.2.4",
        });
      }
      if (url.startsWith("https://uploads.github.com/")) return Response.json({ id: 502, state: "uploaded", digest: `sha256:${sha256}`, size: archive.length });
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases/101" && method === "PATCH") {
        published = true;
        throw new Error("Connection closed after publish.");
      }
      if (url === "https://api.github.com/repos/alice/ponpoko-timer/releases/101" && method === "GET") {
        return Response.json({ id: 101, draft: false, immutable: true, tag_name: "v1.2.4", html_url: "https://github.com/alice/ponpoko-timer/releases/tag/v1.2.4" });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const svc = new PublisherService({ dataDir, hostControlPath: controlPath, fetchImpl: mockHostJobs(fetchImpl), disableGhCli: true });
    await svc.githubConnect("ghp_dummy_token_value_123456");

    const params = { sourceId: "src_timer_r2", repo: "alice/ponpoko-timer" };
    const v1 = await svc.preparePackage(params);
    await expect(svc.publishPackage({ ...params, ...approve(v1) })).rejects.toThrow("already exists");

    version = "1.2.4";
    const v2 = await svc.preparePackage(params);
    const ok = await svc.publishPackage({ ...params, ...approve(v2) });
    expect(ok.version).toBe("1.2.4");
    expect(ok.releaseUrl).toBe("https://github.com/alice/ponpoko-timer/releases/tag/v1.2.4");
  });
});

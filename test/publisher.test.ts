import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("surface-publisher backend", () => {
  test("lists local surface sources and skips surface-publisher itself", async () => {
    const sourcesRoot = makeTempDir("pub-sources-");
    const dataDir = makeTempDir("pub-data-");

    const trackerDir = join(sourcesRoot, "habit-tracker");
    mkdirSync(trackerDir, { recursive: true });
    writeFileSync(
      join(trackerDir, "surface.json"),
      JSON.stringify({ id: "habit-tracker", name: "Habit Tracker", version: "0.2.0" }),
    );

    const selfDir = join(sourcesRoot, "publisher");
    mkdirSync(selfDir, { recursive: true });
    writeFileSync(
      join(selfDir, "surface.json"),
      JSON.stringify({ id: "surface-publisher", name: "Publisher", version: "1.0.0" }),
    );

    const svc = new PublisherService({ dataDir, sourceRoots: [sourcesRoot], disableGhCli: true });
    const list = await svc.listSources();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("habit-tracker");
    expect(list[0].version).toBe("0.2.0");
  });

  test("security scan delegates to PONPOKO_HOST_CONTROL and maps findings/excluded paths", async () => {
    const root = makeTempDir("pub-scan-");
    const dataDir = makeTempDir("pub-data-");
    const controlPath = join(dataDir, "host-control.json");
    writeFileSync(join(root, "surface.json"), JSON.stringify({ id: "notes", name: "Notes", version: "1.0.0" }));
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({
        ok: true,
        snapshot: {
          clean: false,
          scanned_files: 3,
          excluded: [".env"],
          findings: [
            { path: "src/index.ts", reason: "credential_guard: openai_secret" },
            { path: "src/user.sqlite3", reason: "Personal database or private key file found inside source subfolder" },
          ],
        },
      });
    }) as typeof fetch;

    const svc = new PublisherService({
      dataDir,
      sourceRoots: [root],
      hostControlPath: controlPath,
      fetchImpl,
      disableGhCli: true,
    });
    const scan = await svc.scanSecurity(root);
    expect(scan.clean).toBe(false);
    expect(scan.scannedFiles).toBe(3);
    expect(scan.excluded).toContain(".env");
    expect(scan.findings).toHaveLength(2);
    expect(calls[0]?.auth).toBe("Bearer host-secret");
    expect(calls[0]?.body).toMatchObject({
      protocol: 1,
      verb: "runtime",
      surface_id: "surface-publisher",
      extra: { operation: "package.scan_secrets" },
    });
  });

  test("publishPackage packs .surface through Host runtime, blocks unsafe scans, and requires PONPOKO_HOST_CONTROL", async () => {
    const root = makeTempDir("pub-pkg-");
    const dataDir = makeTempDir("pub-data-");
    const controlPath = join(dataDir, "host-control.json");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "surface.json"), JSON.stringify({ id: "timer", name: "Timer", version: "1.2.3", entry: "index.html" }));
    writeFileSync(join(root, "index.html"), "<html><body>Timer</body></html>");
    writeFileSync(controlPath, JSON.stringify({ protocol: 1, url: "http://127.0.0.1:43210/", token: "host-secret" }));

    const noHost = new PublisherService({ dataDir, sourceRoots: [root], disableGhCli: true });
    await expect(noHost.scanSecurity(root)).rejects.toThrow("PONPOKO_HOST_CONTROL");

    let dirty = false;
    const ops: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { extra: { operation: string; output?: string } };
      ops.push(payload.extra.operation);
      if (payload.extra.operation === "package.scan_secrets") {
        return Response.json({
          ok: true,
          snapshot: dirty
            ? { clean: false, scanned_files: 3, findings: [{ path: "src/leak.js", reason: "github token" }], excluded: [] }
            : { clean: true, scanned_files: 2, findings: [], excluded: ["local.sqlite3"] },
        });
      }
      if (payload.extra.operation === "package.pack") {
        const outPath = String(payload.extra.output);
        writeFileSync(outPath, "host-packed-ustar");
        return Response.json({
          ok: true,
          snapshot: {
            path: outPath,
            sha256: "abc123",
            archive_bytes: 17,
            metadata: {
              id: "timer",
              version: "1.2.3",
              bundle_digest: "host-canonical-digest",
              files: [
                { path: "index.html", bytes: 32, sha256: "111", executable: false },
                { path: "surface.json", bytes: 64, sha256: "222", executable: false },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected operation: ${payload.extra.operation}`);
    }) as typeof fetch;

    const svc = new PublisherService({
      dataDir,
      sourceRoots: [root],
      hostControlPath: controlPath,
      fetchImpl,
      disableGhCli: true,
    });
    const pkg = await svc.publishPackage({ path: root, dryRun: true, skipBuild: true });
    expect(pkg.ok).toBe(true);
    expect(pkg.mode).toBe("use_only");
    expect(pkg.surfaceId).toBe("timer");
    expect(pkg.tag).toBe("v1.2.3");
    expect(pkg.bundleDigest).toBe("host-canonical-digest");
    expect(pkg.filesCount).toBe(2);
    expect(pkg.excluded).toContain("local.sqlite3");
    expect(ops).toEqual(["package.scan_secrets", "package.pack"]);

    const srcResult = await svc.publishSource({ path: root, dryRun: true });
    expect(srcResult.ok).toBe(true);
    expect(srcResult.mode).toBe("open_source");
    expect(srcResult.filesCount).toBe(2);

    dirty = true;
    await expect(svc.publishPackage({ path: root, dryRun: true, skipBuild: true })).rejects.toThrow("Security scan blocked");
  });
});

import { createInterface } from "node:readline";
import { join } from "node:path";
import { PublisherService } from "./publisher";
import { PublisherJobs } from "./jobs";
import type { PublicationApproval } from "../shared/types";

const dataDir = process.env.PONPOKO_SURFACE_DATA_DIR;
if (!dataDir) {
  throw new Error("The Host must provide PONPOKO_SURFACE_DATA_DIR");
}

const jobs = new PublisherJobs(join(dataDir, "publisher-jobs"));
const service = new PublisherService({ dataDir, onHostJob: (id, operation) => jobs.noteHostJob(id, operation) });
const BACKGROUND_METHODS = new Set([
  "sources.list", "sources.pick", "sources.request_build", "security.scan", "github.connect",
  "publish.prepare_package", "publish.prepare_source", "publish.package", "publish.source",
]);

function parseApproval(raw: unknown): PublicationApproval | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.digest !== "string" || typeof obj.remote !== "string" || typeof obj.targetRef !== "string") {
    return undefined;
  }
  return {
    digest: obj.digest,
    remote: obj.remote,
    targetRef: obj.targetRef,
    acknowledgedWarnings: obj.acknowledgedWarnings === true,
    distributionDigest: typeof obj.distributionDigest === "string" ? obj.distributionDigest : undefined,
  };
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "job.start": {
      const target = String(params.method ?? "");
      if (!BACKGROUND_METHODS.has(target)) throw new Error("Unsupported job method.");
      const input = params.input as Record<string, unknown> | undefined;
      return jobs.start(String(params.id ?? ""), () => dispatch(target, input ?? {}));
    }
    case "job.status":
      return jobs.status(String(params.id ?? ""), service);
    case "app.info":
      return service.appInfo();
    case "cloud.account":
      return service.cloudAccount();
    case "sources.list":
      return service.listSources();
    case "sources.pick":
      return service.pickSource();
    case "sources.request_build":
      return service.requestBuild(String(params.sourceId ?? ""));
    case "security.scan":
      return service.scanSecurity(String(params.sourceId ?? ""));
    case "github.status":
      return service.githubStatus();
    case "github.connect":
      return service.githubConnect(
        String(params.token ?? ""),
        typeof params.username === "string" ? params.username : undefined,
      );
    case "github.disconnect":
      return service.githubDisconnect();
    case "publish.prepare_package":
      return service.preparePackage({
        sourceId: String(params.sourceId ?? ""),
        repo: typeof params.repo === "string" ? params.repo : undefined,
        tag: typeof params.tag === "string" ? params.tag : undefined,
        notes: typeof params.notes === "string" ? params.notes : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        skipBuild: Boolean(params.skipBuild),
      });
    case "publish.package":
      return service.publishPackage({
        sourceId: String(params.sourceId ?? ""),
        preparedId: typeof params.preparedId === "string" ? params.preparedId : undefined,
        repo: typeof params.repo === "string" ? params.repo : undefined,
        tag: typeof params.tag === "string" ? params.tag : undefined,
        notes: typeof params.notes === "string" ? params.notes : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        dryRun: Boolean(params.dryRun),
        skipBuild: Boolean(params.skipBuild),
        confirmRemote: typeof params.confirmRemote === "string" ? params.confirmRemote : undefined,
        approval: parseApproval(params.approval),
      });
    case "publish.prepare_source":
      return service.prepareSource({
        sourceId: String(params.sourceId ?? ""),
        repo: typeof params.repo === "string" ? params.repo : undefined,
        branch: typeof params.branch === "string" ? params.branch : undefined,
        message: typeof params.message === "string" ? params.message : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        approval: parseApproval(params.approval),
      });
    case "publish.source":
      return service.publishSource({
        sourceId: String(params.sourceId ?? ""),
        preparedId: typeof params.preparedId === "string" ? params.preparedId : undefined,
        repo: typeof params.repo === "string" ? params.repo : undefined,
        branch: typeof params.branch === "string" ? params.branch : undefined,
        message: typeof params.message === "string" ? params.message : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        dryRun: Boolean(params.dryRun),
        confirmRemote: typeof params.confirmRemote === "string" ? params.confirmRemote : undefined,
        approval: parseApproval(params.approval),
      });
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | undefined;
  try {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Request exceeds 4 MiB");
    request = JSON.parse(line);
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string" || request.id === undefined) {
      throw new Error("Invalid JSON-RPC request");
    }
    const result = await dispatch(request.method, request.params ?? {});
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32000, message: String(error) } })}\n`,
    );
  }
}

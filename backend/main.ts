import { createInterface } from "node:readline";
import { PublisherService } from "./publisher";

const dataDir = process.env.PONPOKO_SURFACE_DATA_DIR;
if (!dataDir) {
  throw new Error("The Host must provide PONPOKO_SURFACE_DATA_DIR");
}

const service = new PublisherService({ dataDir });

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "app.info":
      return service.appInfo();
    case "sources.list":
      return service.listSources(Array.isArray(params.roots) ? (params.roots as string[]) : undefined);
    case "security.scan":
      return service.scanSecurity(String(params.path ?? ""));
    case "github.status":
      return service.githubStatus();
    case "github.connect":
      return service.githubConnect(
        String(params.token ?? ""),
        typeof params.username === "string" ? params.username : undefined,
      );
    case "github.disconnect":
      return service.githubDisconnect();
    case "publish.package":
      return service.publishPackage({
        path: String(params.path ?? ""),
        repo: typeof params.repo === "string" ? params.repo : undefined,
        tag: typeof params.tag === "string" ? params.tag : undefined,
        notes: typeof params.notes === "string" ? params.notes : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        dryRun: Boolean(params.dryRun),
        skipBuild: Boolean(params.skipBuild),
      });
    case "publish.source":
      return service.publishSource({
        path: String(params.path ?? ""),
        repo: typeof params.repo === "string" ? params.repo : undefined,
        branch: typeof params.branch === "string" ? params.branch : undefined,
        message: typeof params.message === "string" ? params.message : undefined,
        ownerAccount: typeof params.ownerAccount === "string" ? params.ownerAccount : undefined,
        dryRun: Boolean(params.dryRun),
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

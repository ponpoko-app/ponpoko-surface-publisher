import { createSurfaceClient } from "./sdk/surface.mjs";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PackagePrepareResult,
  PublishPackageParams,
  PublishPackageResult,
  PublishSourceParams,
  PublishSourceResult,
  SecurityScanResult,
  SourcePrepareResult,
} from "../shared/types";

export interface PublisherClient {
  backend<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onPalette(handler: (tokens: Record<string, string>) => void): () => void;
  openExternal(url: string): Promise<void>;
  dispose(): void;
}

export async function connect(): Promise<PublisherClient> {
  const surface = createSurfaceClient();
  await surface.ready();
  return {
    backend: (method, params) => surface.backend(method, params) as Promise<never>,
    onPalette: (handler) => surface.onPalette(handler),
    openExternal: async (url) => {
      await surface.call("host.platform", "link.open", { url });
    },
    dispose: () => surface.dispose(),
  };
}

async function background<T>(client: PublisherClient, method: string, input: Record<string, unknown> = {}): Promise<T> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, "0")).join("");
  await client.backend("job.start", { id, method, input });
  for (;;) {
    const job = await client.backend<{ state: string; result?: T; error?: string }>("job.status", { id });
    if (job.state === "completed" && job.result !== undefined) return job.result;
    if (job.state !== "running") throw new Error(job.error ?? "Publisher did not return a job outcome.");
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

export const listSources = (client: PublisherClient): Promise<LocalSurfaceSource[]> =>
  background(client, "sources.list");

export const pickSource = (client: PublisherClient): Promise<string | null> =>
  background(client, "sources.pick");

export const cloudAccount = (client: PublisherClient): Promise<{ accountId: string | null }> =>
  client.backend<{ accountId: string | null }>("cloud.account");

export const scanSecurity = (client: PublisherClient, sourceId: string): Promise<SecurityScanResult> =>
  background(client, "security.scan", { sourceId });

export const githubStatus = (client: PublisherClient): Promise<GitHubStatus> =>
  client.backend<GitHubStatus>("github.status");

export const githubConnect = (client: PublisherClient, token: string): Promise<GitHubStatus> =>
  background(client, "github.connect", { token });

export const githubDisconnect = (client: PublisherClient): Promise<GitHubStatus> =>
  client.backend<GitHubStatus>("github.disconnect");

export const preparePackage = (
  client: PublisherClient,
  params: PublishPackageParams,
): Promise<PackagePrepareResult> =>
  background(client, "publish.prepare_package", { ...params });

export const publishPackage = (
  client: PublisherClient,
  params: PublishPackageParams,
): Promise<PublishPackageResult> => background(client, "publish.package", { ...params });

export const prepareSource = (
  client: PublisherClient,
  params: PublishSourceParams,
): Promise<SourcePrepareResult> =>
  background(client, "publish.prepare_source", { ...params });

export const publishSource = (
  client: PublisherClient,
  params: PublishSourceParams,
): Promise<PublishSourceResult> => background(client, "publish.source", { ...params });

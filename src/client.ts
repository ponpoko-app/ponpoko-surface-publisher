import { createSurfaceClient } from "./sdk/surface.mjs";
import type {
  GitHubStatus,
  LocalSurfaceSource,
  PublishPackageParams,
  PublishPackageResult,
  PublishSourceParams,
  PublishSourceResult,
  SecurityScanResult,
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

export const listSources = (client: PublisherClient): Promise<LocalSurfaceSource[]> =>
  client.backend<LocalSurfaceSource[]>("sources.list");

export const scanSecurity = (client: PublisherClient, path: string): Promise<SecurityScanResult> =>
  client.backend<SecurityScanResult>("security.scan", { path });

export const githubStatus = (client: PublisherClient): Promise<GitHubStatus> =>
  client.backend<GitHubStatus>("github.status");

export const githubConnect = (client: PublisherClient, token: string): Promise<GitHubStatus> =>
  client.backend<GitHubStatus>("github.connect", { token });

export const githubDisconnect = (client: PublisherClient): Promise<GitHubStatus> =>
  client.backend<GitHubStatus>("github.disconnect");

export const publishPackage = (
  client: PublisherClient,
  params: PublishPackageParams,
): Promise<PublishPackageResult> => client.backend<PublishPackageResult>("publish.package", { ...params });

export const publishSource = (
  client: PublisherClient,
  params: PublishSourceParams,
): Promise<PublishSourceResult> => client.backend<PublishSourceResult>("publish.source", { ...params });

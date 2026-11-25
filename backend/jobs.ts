import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublisherService } from "./publisher";

type Job =
  | { state: "running"; host?: { id: string; operation: string } }
  | { state: "completed"; result: unknown }
  | { state: "failed"; error: string };

export class PublisherJobs {
  private readonly current = new AsyncLocalStorage<string>();
  private readonly active = new Set<string>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job ID.");
    return join(this.directory, `${id}.json`);
  }

  private async save(id: string, job: Job): Promise<void> {
    const path = this.path(id);
    const staged = `${path}.new`;
    await writeFile(staged, JSON.stringify(job), { mode: 0o600 });
    await rename(staged, path);
  }

  async noteHostJob(id: string, operation: string): Promise<void> {
    const jobId = this.current.getStore();
    if (jobId) await this.save(jobId, { state: "running", host: { id, operation } });
  }

  async start(id: string, run: () => Promise<unknown>): Promise<{ id: string }> {
    const path = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify({ state: "running" }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { id };
      throw error;
    }
    this.active.add(id);
    void this.current.run(id, async () => {
      try {
        const result = await run();
        await this.save(id, { state: "completed", result });
      } catch (error) {
        await this.save(id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.active.delete(id);
      }
    }).catch(() => {});
    return { id };
  }

  async status(id: string, service: PublisherService): Promise<Job> {
    const job = JSON.parse(await readFile(this.path(id), "utf8")) as Job;
    if (job.state !== "running" || this.active.has(id)) return job;
    const host = job.host && await service.hostJobStatus(job.host.id).catch(() => null);
    if (host?.state === "running") return job;
    let detail = host?.error || (job.host && `Host ${job.host.operation}: ${host?.state ?? "unknown"}.`);
    if (job.host?.operation === "git.push_publication" && host?.state === "completed") {
      const result = host.result as { pushed?: boolean } | undefined;
      if (result?.pushed === true) detail = "Host confirmed the Git push.";
      if (result?.pushed === false) detail = "Host could not confirm the Git push.";
    }
    return {
      state: "failed",
      error: `Publisher stopped before it recorded the outcome. ${detail ?? ""} Inspect the destination before retrying. Job ID: ${id}.`,
    };
  }
}

import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateRunSnapshot } from "./migration.js";
import type { RunEvent, RunSnapshot } from "./types.js";

interface LockHandle {
  release(): Promise<void>;
}

async function replaceFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  // Windows antivirus and indexers can briefly prevent atomic replacement.
  // The run lock still guarantees a single writer, so copying is a safe fallback.
  await copyFile(temporary, destination);
  await rm(temporary, { force: true });
}

async function acquireLock(
  lockPath: string,
  timeoutMs = 30_000,
  staleMs = 10 * 60_000
): Promise<LockHandle> {
  const start = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
      );
      await handle.close();
      return {
        async release() {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for run lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
}

export class RunStore {
  constructor(readonly rootDirectory: string) {}

  runDirectory(runId: string): string {
    return join(this.rootDirectory, "runs", runId);
  }

  private snapshotPath(runId: string): string {
    return join(this.runDirectory(runId), "snapshot.json");
  }

  private eventsPath(runId: string): string {
    return join(this.runDirectory(runId), "events.jsonl");
  }

  private lockPath(runId: string): string {
    return join(this.runDirectory(runId), ".lock");
  }

  async create(snapshot: RunSnapshot, event: RunEvent): Promise<void> {
    const directory = this.runDirectory(snapshot.id);
    await mkdir(join(this.rootDirectory, "runs"), { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeFile(this.snapshotPath(snapshot.id), JSON.stringify(snapshot, null, 2));
    await appendFile(this.eventsPath(snapshot.id), `${JSON.stringify(event)}\n`);
  }

  async load(runId: string): Promise<RunSnapshot> {
    const snapshotPath = this.snapshotPath(runId);
    const source = await readFile(snapshotPath, "utf8");
    const migration = migrateRunSnapshot(JSON.parse(source));
    if (migration.migrated) {
      const backupPath = join(
        this.runDirectory(runId),
        `snapshot.schema-${String(migration.sourceSchemaVersion)}.backup.json`
      );
      try {
        await writeFile(backupPath, source, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const temporary = `${snapshotPath}.migration-${process.pid}`;
      await writeFile(temporary, JSON.stringify(migration.snapshot, null, 2));
      await replaceFile(temporary, snapshotPath);
    }
    return migration.snapshot;
  }

  async events(runId: string): Promise<RunEvent[]> {
    const source = await readFile(this.eventsPath(runId), "utf8");
    return source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  async update(
    runId: string,
    mutator: (snapshot: RunSnapshot, events: RunEvent[]) => RunEvent | RunEvent[]
  ): Promise<RunSnapshot> {
    const lock = await acquireLock(this.lockPath(runId));
    try {
      const snapshot = await this.load(runId);
      const events = await this.events(runId);
      const newEvents = mutator(snapshot, events);
      const items = Array.isArray(newEvents) ? newEvents : [newEvents];
      for (const event of items) {
        await appendFile(this.eventsPath(runId), `${JSON.stringify(event)}\n`);
      }
      snapshot.updatedAt = new Date().toISOString();
      const temporary = `${this.snapshotPath(runId)}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2));
      await replaceFile(temporary, this.snapshotPath(runId));
      return snapshot;
    } finally {
      await lock.release();
    }
  }
}

export function nextEvent(
  events: RunEvent[],
  runId: string,
  type: RunEvent["type"],
  actor: string,
  data: Record<string, unknown>
): RunEvent {
  return {
    sequence: events.length + 1,
    runId,
    type,
    timestamp: new Date().toISOString(),
    actor,
    data
  };
}

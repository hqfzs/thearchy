import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { migrateRunSnapshot } from "./migration.js";
import type { RunEvent, RunSnapshot } from "./types.js";

type TransactionPhase =
  | "prepared"
  | "events_appended"
  | "snapshot_replaced"
  | "committed";

export type StoreFailurePoint =
  | "after-backup"
  | "after-pending-write"
  | "after-events-append"
  | "after-tail-repair"
  | "before-snapshot-replace"
  | "after-snapshot-replace"
  | "after-recovery-event"
  | "before-pending-cleanup";

export interface StoreFailureContext {
  runId: string;
  txId?: string;
  phase: TransactionPhase | "tail_repair" | "recovery_event";
}

export interface RunStoreOptions {
  /**
   * Test-only deterministic interruption hook. Production callers omit it.
   * Throwing from the hook leaves the pending transaction in place so a new
   * RunStore instance can recover it.
   */
  failureInjector?: (
    point: StoreFailurePoint,
    context: StoreFailureContext
  ) => void | Promise<void>;
  /** Alias retained for callers that name the hook after the feature. */
  failureInjection?: (
    point: StoreFailurePoint,
    context: StoreFailureContext
  ) => void | Promise<void>;
}

interface PendingTransaction {
  txId: string;
  runId: string;
  sourceSnapshotSha256: string;
  sourceEventsSha256: string;
  targetSnapshotSha256: string;
  eventStartSequence: number;
  eventEndSequence: number;
  createdAt: string;
  phase: TransactionPhase;
  baseEventCount: number;
  snapshot: RunSnapshot;
  events: RunEvent[];
  backupSnapshotPath: string | null;
  backupEventsPath: string | null;
}

interface EventLogRead {
  source: string;
  events: RunEvent[];
  truncatedFinalLine: boolean;
  validPrefix: string;
  corruption?: {
    line: number;
    message: string;
  };
}

let transactionSequence = 0;

function newTransactionId(): string {
  transactionSequence += 1;
  return `${Date.now()}-${process.pid}-${transactionSequence}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function durableWrite(
  path: string,
  content: string,
  flag: "w" | "wx" = "w"
): Promise<void> {
  const handle = await open(path, flag);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableAppend(path: string, content: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync is not available on every Windows filesystem. The file
  // fsyncs above are still useful; a directory sync is best effort.
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort only.
  }
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
): Promise<{ release(): Promise<void> }> {
  const start = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
      );
      await handle.sync();
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTransactionPhase(value: unknown): value is TransactionPhase {
  return (
    value === "prepared" ||
    value === "events_appended" ||
    value === "snapshot_replaced" ||
    value === "committed"
  );
}

function isPendingTransaction(value: unknown): value is PendingTransaction {
  if (!isObject(value)) return false;
  return (
    typeof value.txId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sourceSnapshotSha256 === "string" &&
    typeof value.sourceEventsSha256 === "string" &&
    typeof value.targetSnapshotSha256 === "string" &&
    typeof value.eventStartSequence === "number" &&
    typeof value.eventEndSequence === "number" &&
    typeof value.createdAt === "string" &&
    isTransactionPhase(value.phase) &&
    typeof value.baseEventCount === "number" &&
    isObject(value.snapshot) &&
    Array.isArray(value.events) &&
    value.events.every((event) => isObject(event)) &&
    (typeof value.backupSnapshotPath === "string" ||
      value.backupSnapshotPath === null) &&
    (typeof value.backupEventsPath === "string" || value.backupEventsPath === null)
  );
}

function recoveryEventId(value: RunEvent): string | undefined {
  if (value.type !== ("store.recovered" as unknown as RunEvent["type"])) {
    return undefined;
  }
  const recoveryId = value.data?.recoveryId;
  return typeof recoveryId === "string" ? recoveryId : undefined;
}

function isRecoveryEventFor(events: RunEvent[], recoveryId: string): boolean {
  return events.some((event) => recoveryEventId(event) === recoveryId);
}

function recoveryEvent(
  events: RunEvent[],
  runId: string,
  actor: string,
  data: Record<string, unknown>
): RunEvent {
  return {
    sequence: events.length + 1,
    runId,
    type: "store.recovered" as unknown as RunEvent["type"],
    timestamp: new Date().toISOString(),
    actor,
    data
  };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validPrefixBeforeFinalLine(source: string): string {
  const newline = source.lastIndexOf("\n");
  return newline >= 0 ? source.slice(0, newline + 1) : "";
}

function parseEventLog(source: string): EventLogRead {
  const lines = source.split(/\r?\n/);
  const hasTerminalNewline = source.endsWith("\n") || source.endsWith("\r");
  let lastNonEmptyLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      lastNonEmptyLine = index;
      break;
    }
  }

  const events: RunEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) throw new Error("event is not a JSON object");
      events.push(parsed as unknown as RunEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (index === lastNonEmptyLine && !hasTerminalNewline) {
        return {
          source,
          events,
          truncatedFinalLine: true,
          validPrefix: validPrefixBeforeFinalLine(source)
        };
      }
      return {
        source,
        events,
        truncatedFinalLine: false,
        validPrefix: "",
        corruption: { line: index + 1, message }
      };
    }
  }

  return {
    source,
    events,
    truncatedFinalLine: false,
    validPrefix: source
  };
}

export class RunStore {
  constructor(
    readonly rootDirectory: string,
    private readonly options: RunStoreOptions = {}
  ) {}

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

  private pendingTransactionPath(runId: string): string {
    return join(this.runDirectory(runId), "pending-transaction.json");
  }

  private recoveryEventsPath(runId: string): string {
    return join(this.runDirectory(runId), "recovery-events.jsonl");
  }

  private async inject(
    point: StoreFailurePoint,
    context: StoreFailureContext
  ): Promise<void> {
    await (this.options.failureInjector ?? this.options.failureInjection)?.(
      point,
      context
    );
  }

  private async readEventLogUnlocked(runId: string): Promise<EventLogRead> {
    const source = (await readOptional(this.eventsPath(runId))) ?? "";
    return parseEventLog(source);
  }

  private async readSnapshotRawUnlocked(runId: string): Promise<string | null> {
    return readOptional(this.snapshotPath(runId));
  }

  private async writeSnapshotAtomicUnlocked(
    runId: string,
    snapshot: RunSnapshot,
    txId: string
  ): Promise<void> {
    const snapshotPath = this.snapshotPath(runId);
    const temporary = `${snapshotPath}.tmp-${txId}`;
    await rm(temporary, { force: true });
    await durableWrite(temporary, `${prettyJson(snapshot)}\n`, "wx");
    await replaceFile(temporary, snapshotPath);
    await syncDirectory(this.runDirectory(runId));
  }

  private async writePendingTransactionUnlocked(
    transaction: PendingTransaction
  ): Promise<void> {
    const destination = this.pendingTransactionPath(transaction.runId);
    const temporary = `${destination}.tmp-${transaction.txId}`;
    await rm(temporary, { force: true });
    await durableWrite(temporary, `${prettyJson(transaction)}\n`, "wx");
    await replaceFile(temporary, destination);
    await syncDirectory(this.runDirectory(transaction.runId));
  }

  private async preserveCorruptFileUnlocked(
    runId: string,
    fileName: string,
    source: string
  ): Promise<string> {
    const stablePath = join(this.runDirectory(runId), `${fileName}.corrupt`);
    try {
      await durableWrite(stablePath, source, "wx");
      return stablePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readOptional(stablePath)) === source) return stablePath;
    }

    const uniquePath = join(
      this.runDirectory(runId),
      `${fileName}.corrupt-${newTransactionId()}`
    );
    await durableWrite(uniquePath, source, "wx");
    return uniquePath;
  }

  private async backupSourcesUnlocked(
    runId: string,
    transaction: PendingTransaction,
    snapshotSource: string | null,
    eventsSource: string | null
  ): Promise<void> {
    const backupDirectory = join(this.runDirectory(runId), "backup");
    await mkdir(backupDirectory, { recursive: true });

    if (snapshotSource !== null) {
      const snapshotBackup = join(
        backupDirectory,
        `snapshot.${transaction.txId}.${transaction.sourceSnapshotSha256}.json`
      );
      await durableWrite(snapshotBackup, snapshotSource, "wx");
      const previousSnapshot = join(this.runDirectory(runId), "snapshot.previous.json");
      await durableWrite(previousSnapshot, snapshotSource, "w");
      transaction.backupSnapshotPath = snapshotBackup;
    }

    if (eventsSource !== null) {
      const eventsBackup = join(
        backupDirectory,
        `events.${transaction.txId}.${transaction.sourceEventsSha256}.jsonl`
      );
      await durableWrite(eventsBackup, eventsSource, "wx");
      transaction.backupEventsPath = eventsBackup;
    }

    await syncDirectory(backupDirectory);
  }

  private async readPendingTransactionUnlocked(
    runId: string
  ): Promise<PendingTransaction | undefined> {
    const source = await readOptional(this.pendingTransactionPath(runId));
    if (source === null) return undefined;
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isPendingTransaction(parsed) || parsed.runId !== runId) {
        throw new Error("pending transaction has an invalid shape");
      }
      return parsed;
    } catch (error) {
      await this.preserveCorruptFileUnlocked(
        runId,
        "pending-transaction.json",
        source
      );
      const snapshot = await this.readSnapshotForRecoveryUnlocked(runId);
      await this.markReadOnlyRecoveryUnlocked(
        runId,
        snapshot,
        `Pending transaction is corrupt: ${
          error instanceof Error ? error.message : String(error)
        }`,
        snapshot.schemaVersion
      );
      return undefined;
    }
  }

  private async readSnapshotForRecoveryUnlocked(
    runId: string
  ): Promise<RunSnapshot> {
    const source = await this.readSnapshotRawUnlocked(runId);
    if (source === null) {
      const migrated = migrateRunSnapshot({});
      return { ...migrated.snapshot, id: runId };
    }
    try {
      const parsed: unknown = JSON.parse(source);
      if (isObject(parsed) && parsed.schemaVersion === 3) {
        return parsed as unknown as RunSnapshot;
      }
      const migration = migrateRunSnapshot(parsed);
      return migration.snapshot as RunSnapshot;
    } catch (error) {
      await this.preserveCorruptFileUnlocked(runId, "snapshot.json", source);
      const migrated = migrateRunSnapshot({});
      return {
        ...migrated.snapshot,
        id: runId,
        readOnlyRecovery: {
          reason: `Snapshot is corrupt: ${
            error instanceof Error ? error.message : String(error)
          }`,
          sourceSchemaVersion: undefined
        }
      };
    }
  }

  private async readSnapshotUnlocked(runId: string): Promise<RunSnapshot> {
    const source = await readFile(this.snapshotPath(runId), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      await this.preserveCorruptFileUnlocked(runId, "snapshot.json", source);
      const recovery = await this.readSnapshotForRecoveryUnlocked(runId);
      return this.markReadOnlyRecoveryUnlocked(
        runId,
        recovery,
        `Snapshot is corrupt: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined
      );
    }

    if (isObject(parsed) && parsed.schemaVersion === 3) {
      return parsed as unknown as RunSnapshot;
    }

    const migration = migrateRunSnapshot(parsed);
    if (migration.migrated) {
      const backupPath = join(
        this.runDirectory(runId),
        `snapshot.schema-${String(migration.sourceSchemaVersion)}.backup.json`
      );
      try {
        await durableWrite(backupPath, source, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.writeSnapshotAtomicUnlocked(
        runId,
        migration.snapshot,
        `migration-${newTransactionId()}`
      );
    }
    return migration.snapshot as RunSnapshot;
  }

  private async markReadOnlyRecoveryUnlocked(
    runId: string,
    snapshot: RunSnapshot,
    reason: string,
    sourceSchemaVersion: unknown
  ): Promise<RunSnapshot> {
    const marked: RunSnapshot = {
      ...snapshot,
      readOnlyRecovery: {
        reason,
        sourceSchemaVersion
      }
    };

    if (
      snapshot.readOnlyRecovery?.reason === reason &&
      snapshot.readOnlyRecovery.sourceSchemaVersion === sourceSchemaVersion
    ) {
      return marked;
    }

    try {
      const source = await this.readSnapshotRawUnlocked(runId);
      if (source !== null) {
        const backup = join(
          this.runDirectory(runId),
          `snapshot.recovery-${sha256(source).slice(0, 16)}.backup.json`
        );
        try {
          await durableWrite(backup, source, "wx");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      await this.writeSnapshotAtomicUnlocked(
        runId,
        marked,
        `recovery-${newTransactionId()}`
      );
    } catch {
      // The marked in-memory snapshot is still returned if the filesystem is
      // itself read-only or unavailable.
    }
    return marked;
  }

  private async appendActiveRecoveryEventUnlocked(
    runId: string,
    events: RunEvent[],
    recoveryId: string,
    data: Record<string, unknown>,
    txId?: string
  ): Promise<void> {
    if (isRecoveryEventFor(events, recoveryId)) return;
    const event = recoveryEvent(events, runId, "store", {
      recoveryId,
      ...data,
      auditLocation: "events.jsonl"
    });
    await durableAppend(this.eventsPath(runId), `${json(event)}\n`);
    await this.inject("after-recovery-event", {
      runId,
      ...(txId ? { txId } : {}),
      phase: "recovery_event"
    });
  }

  private async appendRecoverySidecarUnlocked(
    runId: string,
    events: RunEvent[],
    recoveryId: string,
    data: Record<string, unknown>,
    txId?: string
  ): Promise<void> {
    const sidecarSource =
      (await readOptional(this.recoveryEventsPath(runId))) ?? "";
    const sidecar = parseEventLog(sidecarSource).events;
    if (isRecoveryEventFor(sidecar, recoveryId)) return;
    const event = recoveryEvent(sidecar, runId, "store", {
      recoveryId,
      ...data,
      auditLocation: "recovery-events.jsonl",
      activeEventSequence: events.length + 1
    });
    await durableAppend(this.recoveryEventsPath(runId), `${json(event)}\n`);
    await this.inject("after-recovery-event", {
      runId,
      ...(txId ? { txId } : {}),
      phase: "recovery_event"
    });
  }

  private async handleEventCorruptionUnlocked(
    runId: string,
    log: EventLogRead,
    transaction?: PendingTransaction
  ): Promise<RunSnapshot> {
    const corruptPath = await this.preserveCorruptFileUnlocked(
      runId,
      "events.jsonl",
      log.source
    );
    const snapshot = await this.readSnapshotForRecoveryUnlocked(runId);
    const marked = await this.markReadOnlyRecoveryUnlocked(
      runId,
      snapshot,
      `Event log corruption before final line ${String(
        log.corruption?.line ?? "unknown"
      )}: ${log.corruption?.message ?? "invalid event"}`,
      snapshot.schemaVersion
    );
    const recoveryId =
      transaction?.txId ?? `events-${sha256(log.source).slice(0, 24)}`;
    await this.appendRecoverySidecarUnlocked(
      runId,
      log.events,
      recoveryId,
      {
        txId: transaction?.txId ?? null,
        outcome: "read-only",
        backupSnapshotPath: transaction?.backupSnapshotPath ?? null,
        backupEventsPath: transaction?.backupEventsPath ?? corruptPath,
        sourceSnapshotSha256: transaction?.sourceSnapshotSha256 ?? null,
        sourceEventsSha256:
          transaction?.sourceEventsSha256 ?? sha256(log.source),
        reason: marked.readOnlyRecovery?.reason ?? "event log corruption",
        timestamp: new Date().toISOString()
      },
      transaction?.txId
    );
    return marked;
  }

  private async repairTruncatedTailUnlocked(
    runId: string,
    log: EventLogRead,
    txId?: string
  ): Promise<RunEvent[]> {
    const originalHash = sha256(log.source);
    const backupDirectory = join(this.runDirectory(runId), "backup");
    await mkdir(backupDirectory, { recursive: true });
    const backupPath = join(
      backupDirectory,
      `events.truncated.${originalHash}.jsonl`
    );
    try {
      await durableWrite(backupPath, log.source, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await durableWrite(this.eventsPath(runId), log.validPrefix, "w");
    await this.inject("after-tail-repair", {
      runId,
      ...(txId ? { txId } : {}),
      phase: "tail_repair"
    });
    if (txId) {
      return parseEventLog(log.validPrefix).events;
    }
    const repaired = parseEventLog(log.validPrefix);
    await this.appendActiveRecoveryEventUnlocked(
      runId,
      repaired.events,
      `truncated-${originalHash}`,
      {
        txId: txId ?? null,
        outcome: "tail-repaired",
        backupSnapshotPath: null,
        backupEventsPath: backupPath,
        sourceSnapshotSha256: null,
        sourceEventsSha256: originalHash,
        reason: "truncated final JSONL line",
        timestamp: new Date().toISOString()
      },
      txId
    );
    const finalLog = await this.readEventLogUnlocked(runId);
    return finalLog.events;
  }

  private async validateTransactionBaseUnlocked(
    transaction: PendingTransaction,
    events: RunEvent[]
  ): Promise<boolean> {
    if (events.length < transaction.baseEventCount) return false;
    if (!transaction.backupEventsPath) return true;
    const source = await readOptional(transaction.backupEventsPath);
    if (source === null) return false;
    const backup = parseEventLog(source);
    if (backup.corruption || backup.truncatedFinalLine) return false;
    if (backup.events.length < transaction.baseEventCount) return false;
    for (let index = 0; index < transaction.baseEventCount; index += 1) {
      if (json(events[index]) !== json(backup.events[index])) return false;
    }
    return true;
  }

  private transactionEventsMatch(
    transaction: PendingTransaction,
    events: RunEvent[]
  ): boolean {
    const count = Math.min(
      transaction.events.length,
      Math.max(0, events.length - transaction.baseEventCount)
    );
    for (let index = 0; index < count; index += 1) {
      if (
        json(events[transaction.baseEventCount + index]) !==
        json(transaction.events[index])
      ) {
        return false;
      }
    }
    return true;
  }

  private async recoverPendingTransactionUnlocked(
    runId: string,
    transaction: PendingTransaction
  ): Promise<void> {
    let log = await this.readEventLogUnlocked(runId);
    if (log.corruption) {
      await this.handleEventCorruptionUnlocked(runId, log, transaction);
      return;
    }

    let repairedFinalLine = false;
    if (log.truncatedFinalLine) {
      await this.repairTruncatedTailUnlocked(runId, log, transaction.txId);
      log = await this.readEventLogUnlocked(runId);
      repairedFinalLine = true;
    }

    if (!(await this.validateTransactionBaseUnlocked(transaction, log.events))) {
      await this.handleEventCorruptionUnlocked(
        runId,
        {
          ...log,
          corruption: {
            line: transaction.baseEventCount + 1,
            message: "event log diverged from the transaction source prefix"
          }
        },
        transaction
      );
      return;
    }

    const expectedEnd = transaction.baseEventCount + transaction.events.length;
    if (!this.transactionEventsMatch(transaction, log.events)) {
      await this.handleEventCorruptionUnlocked(
        runId,
        {
          ...log,
          corruption: {
            line: transaction.baseEventCount + 1,
            message: "event log transaction suffix does not match the journal"
          }
        },
        transaction
      );
      return;
    }
    if (log.events.length > expectedEnd) {
      const tail = log.events.slice(expectedEnd);
      if (
        !(
          tail.length === 1 &&
          recoveryEventId(tail[0] as RunEvent) === transaction.txId
        )
      ) {
        await this.handleEventCorruptionUnlocked(
          runId,
          {
            ...log,
            corruption: {
              line: expectedEnd + 1,
              message: "event log contains an unexpected suffix"
            }
          },
          transaction
        );
        return;
      }
    }

    if (log.events.length < expectedEnd) {
      const alreadyAppended = Math.max(
        0,
        log.events.length - transaction.baseEventCount
      );
      for (
        let index = alreadyAppended;
        index < transaction.events.length;
        index += 1
      ) {
        const event = transaction.events[index];
        if (event) {
          await durableAppend(this.eventsPath(runId), `${json(event)}\n`);
        }
      }
      log = await this.readEventLogUnlocked(runId);
      if (log.corruption || log.truncatedFinalLine) {
        await this.handleEventCorruptionUnlocked(runId, log, transaction);
        return;
      }
    }

    const currentSnapshotSource = await this.readSnapshotRawUnlocked(runId);
    let currentSnapshot: RunSnapshot | undefined;
    if (currentSnapshotSource !== null) {
      try {
        currentSnapshot = JSON.parse(currentSnapshotSource) as RunSnapshot;
      } catch {
        await this.preserveCorruptFileUnlocked(
          runId,
          "snapshot.json",
          currentSnapshotSource
        );
      }
    }
    if (json(currentSnapshot) !== json(transaction.snapshot)) {
      await this.writeSnapshotAtomicUnlocked(
        runId,
        transaction.snapshot,
        transaction.txId
      );
    }

    if (transaction.phase !== "snapshot_replaced") {
      transaction.phase = "snapshot_replaced";
      await this.writePendingTransactionUnlocked(transaction);
    }

    const recoveryId = transaction.txId;
    const finalLog = await this.readEventLogUnlocked(runId);
    if (finalLog.corruption || finalLog.truncatedFinalLine) {
      await this.handleEventCorruptionUnlocked(runId, finalLog, transaction);
      return;
    }
    if (!isRecoveryEventFor(finalLog.events, recoveryId)) {
      await this.appendActiveRecoveryEventUnlocked(
        runId,
        finalLog.events,
        recoveryId,
        {
          txId: transaction.txId,
          outcome: "committed",
          backupSnapshotPath: transaction.backupSnapshotPath,
          backupEventsPath: transaction.backupEventsPath,
          sourceSnapshotSha256: transaction.sourceSnapshotSha256,
          sourceEventsSha256: transaction.sourceEventsSha256,
          reason: repairedFinalLine
            ? "pending transaction recovered after truncated final line"
            : "pending transaction recovered",
          timestamp: new Date().toISOString()
        },
        transaction.txId
      );
    }

    await this.inject("before-pending-cleanup", {
      runId,
      txId: transaction.txId,
      phase: "committed"
    });
    transaction.phase = "committed";
    await this.writePendingTransactionUnlocked(transaction);
    await rm(this.pendingTransactionPath(runId), { force: true });
  }

  private async recoverPendingUnlocked(runId: string): Promise<void> {
    const transaction = await this.readPendingTransactionUnlocked(runId);
    if (!transaction) return;
    await this.recoverPendingTransactionUnlocked(runId, transaction);
  }

  private async prepareRunUnlocked(runId: string): Promise<RunSnapshot> {
    await this.recoverPendingUnlocked(runId);
    const log = await this.readEventLogUnlocked(runId);
    if (log.corruption) {
      return this.handleEventCorruptionUnlocked(runId, log);
    }
    if (log.truncatedFinalLine) {
      await this.repairTruncatedTailUnlocked(runId, log);
    }
    return this.readSnapshotUnlocked(runId);
  }

  private async commitTransactionUnlocked(
    transaction: PendingTransaction,
    snapshotSource: string | null,
    eventsSource: string | null
  ): Promise<void> {
    const runId = transaction.runId;
    const currentSnapshotSource = await this.readSnapshotRawUnlocked(runId);
    const currentEventsSource = await readOptional(this.eventsPath(runId));
    if (
      sha256(currentSnapshotSource ?? "") !== transaction.sourceSnapshotSha256 ||
      sha256(currentEventsSource ?? "") !== transaction.sourceEventsSha256
    ) {
      throw new Error(`Run ${runId} changed while preparing a transaction`);
    }

    await this.backupSourcesUnlocked(
      runId,
      transaction,
      snapshotSource,
      eventsSource
    );
    await this.inject("after-backup", {
      runId,
      txId: transaction.txId,
      phase: "prepared"
    });

    await this.writePendingTransactionUnlocked(transaction);
    await this.inject("after-pending-write", {
      runId,
      txId: transaction.txId,
      phase: "prepared"
    });

    if (transaction.events.length > 0) {
      await durableAppend(
        this.eventsPath(runId),
        `${transaction.events.map((event) => json(event)).join("\n")}\n`
      );
    }
    transaction.phase = "events_appended";
    await this.writePendingTransactionUnlocked(transaction);
    await this.inject("after-events-append", {
      runId,
      txId: transaction.txId,
      phase: "events_appended"
    });

    await this.inject("before-snapshot-replace", {
      runId,
      txId: transaction.txId,
      phase: "events_appended"
    });
    await this.writeSnapshotAtomicUnlocked(
      runId,
      transaction.snapshot,
      transaction.txId
    );
    transaction.phase = "snapshot_replaced";
    await this.writePendingTransactionUnlocked(transaction);
    await this.inject("after-snapshot-replace", {
      runId,
      txId: transaction.txId,
      phase: "snapshot_replaced"
    });

    transaction.phase = "committed";
    await this.writePendingTransactionUnlocked(transaction);
    await rm(this.pendingTransactionPath(runId), { force: true });
  }

  async recoverFromBackup(
    runId: string,
    backupId: string,
    expectedSnapshotSha256: string
  ): Promise<RunSnapshot> {
    if (
      !/^[A-Za-z0-9._-]+$/.test(backupId) ||
      basename(backupId) !== backupId
    ) {
      throw new Error("Invalid backup id");
    }
    const lock = await acquireLock(this.lockPath(runId));
    try {
      const backupDirectory = join(this.runDirectory(runId), "backup");
      const entries = await readdir(backupDirectory);
      const snapshotName = entries.find(
        (name) =>
          name.startsWith(`snapshot.${backupId}.`) && name.endsWith(".json")
      );
      const eventsName = entries.find(
        (name) =>
          name.startsWith(`events.${backupId}.`) && name.endsWith(".jsonl")
      );
      if (!snapshotName || !eventsName) {
        throw new Error(`Backup pair not found: ${backupId}`);
      }
      const snapshotSource = await readFile(
        join(backupDirectory, snapshotName),
        "utf8"
      );
      if (sha256(snapshotSource) !== expectedSnapshotSha256) {
        throw new Error("Backup snapshot hash confirmation failed");
      }
      const eventsSource = await readFile(
        join(backupDirectory, eventsName),
        "utf8"
      );
      const log = parseEventLog(eventsSource);
      if (log.corruption || log.truncatedFinalLine) {
        throw new Error("Backup event log is corrupt");
      }
      const migration = migrateRunSnapshot(JSON.parse(snapshotSource));
      const restored = migration.snapshot;
      if (restored.id !== runId) throw new Error("Backup run id mismatch");
      delete restored.readOnlyRecovery;
      restored.updatedAt = new Date().toISOString();

      const currentSnapshot = await this.readSnapshotRawUnlocked(runId);
      const currentEvents = await readOptional(this.eventsPath(runId));
      const recoveryId = `manual-${newTransactionId()}`;
      if (currentSnapshot !== null) {
        await this.preserveCorruptFileUnlocked(
          runId,
          `snapshot.pre-${recoveryId}.json`,
          currentSnapshot
        );
      }
      if (currentEvents !== null) {
        await this.preserveCorruptFileUnlocked(
          runId,
          `events.pre-${recoveryId}.jsonl`,
          currentEvents
        );
      }
      await durableWrite(this.eventsPath(runId), log.validPrefix, "w");
      await this.appendActiveRecoveryEventUnlocked(
        runId,
        log.events,
        recoveryId,
        {
          txId: backupId,
          outcome: "manual-restore",
          backupSnapshotPath: join(backupDirectory, snapshotName),
          backupEventsPath: join(backupDirectory, eventsName),
          sourceSnapshotSha256: expectedSnapshotSha256,
          sourceEventsSha256: sha256(eventsSource),
          reason: "explicit user-confirmed backup restore",
          timestamp: new Date().toISOString()
        },
        backupId
      );
      await this.writeSnapshotAtomicUnlocked(runId, restored, recoveryId);
      await rm(this.pendingTransactionPath(runId), { force: true });
      return restored;
    } finally {
      await lock.release();
    }
  }

  async create(snapshot: RunSnapshot, event: RunEvent): Promise<void> {
    const directory = this.runDirectory(snapshot.id);
    await mkdir(join(this.rootDirectory, "runs"), { recursive: true });
    await mkdir(directory, { recursive: false });
    const lock = await acquireLock(this.lockPath(snapshot.id));
    try {
      const transactionId = newTransactionId();
      const transaction: PendingTransaction = {
        txId: transactionId,
        runId: snapshot.id,
        sourceSnapshotSha256: sha256(""),
        sourceEventsSha256: sha256(""),
        targetSnapshotSha256: sha256(json(snapshot)),
        eventStartSequence: event.sequence,
        eventEndSequence: event.sequence,
        createdAt: new Date().toISOString(),
        phase: "prepared",
        baseEventCount: 0,
        snapshot,
        events: [event],
        backupSnapshotPath: null,
        backupEventsPath: null
      };
      await this.commitTransactionUnlocked(transaction, null, null);
    } finally {
      await lock.release();
    }
  }

  async load(runId: string): Promise<RunSnapshot> {
    const lock = await acquireLock(this.lockPath(runId));
    try {
      return await this.prepareRunUnlocked(runId);
    } finally {
      await lock.release();
    }
  }

  async events(runId: string): Promise<RunEvent[]> {
    const lock = await acquireLock(this.lockPath(runId));
    try {
      const snapshot = await this.prepareRunUnlocked(runId);
      if (snapshot.readOnlyRecovery) {
        throw new Error(
          `Run ${runId} is in read-only recovery: ${snapshot.readOnlyRecovery.reason}`
        );
      }
      const log = await this.readEventLogUnlocked(runId);
      if (log.corruption || log.truncatedFinalLine) {
        throw new Error(`Event log for run ${runId} is not readable`);
      }
      return log.events;
    } finally {
      await lock.release();
    }
  }

  async findActiveRun(criteria: {
    repositoryRoot?: string | undefined;
    taskFingerprint: string;
    templateId: string;
  }): Promise<RunSnapshot | undefined> {
    const runsDirectory = join(this.rootDirectory, "runs");
    let entries;
    try {
      entries = await readdir(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const matches: RunSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const snapshot = await this.load(entry.name);
        if (
          !["completed", "cancelled"].includes(snapshot.state) &&
          !snapshot.readOnlyRecovery &&
          snapshot.taskFingerprint === criteria.taskFingerprint &&
          snapshot.templateId === criteria.templateId &&
          (snapshot.repositoryRoot ?? "") === (criteria.repositoryRoot ?? "")
        ) {
          matches.push(snapshot);
        }
      } catch {
        // Corrupted runs are ignored here and remain available for recovery.
      }
    }
    return matches.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    )[0];
  }

  async update(
    runId: string,
    mutator: (snapshot: RunSnapshot, events: RunEvent[]) => RunEvent | RunEvent[]
  ): Promise<RunSnapshot> {
    const lock = await acquireLock(this.lockPath(runId));
    try {
      const snapshot = await this.prepareRunUnlocked(runId);
      if (snapshot.readOnlyRecovery) {
        throw new Error(
          `Run ${runId} is in read-only recovery: ${snapshot.readOnlyRecovery.reason}`
        );
      }
      const eventLog = await this.readEventLogUnlocked(runId);
      if (eventLog.corruption || eventLog.truncatedFinalLine) {
        throw new Error(`Event log for run ${runId} is not readable`);
      }
      const snapshotSource = await this.readSnapshotRawUnlocked(runId);
      const eventsSource = eventLog.source;
      const newEvents = mutator(snapshot, eventLog.events);
      const items = Array.isArray(newEvents) ? newEvents : [newEvents];
      snapshot.updatedAt = new Date().toISOString();
      const transactionId = newTransactionId();
      const transaction: PendingTransaction = {
        txId: transactionId,
        runId,
        sourceSnapshotSha256: sha256(snapshotSource ?? ""),
        sourceEventsSha256: sha256(eventsSource),
        targetSnapshotSha256: sha256(json(snapshot)),
        eventStartSequence: items[0]?.sequence ?? eventLog.events.length + 1,
        eventEndSequence:
          items[items.length - 1]?.sequence ?? eventLog.events.length,
        createdAt: new Date().toISOString(),
        phase: "prepared",
        baseEventCount: eventLog.events.length,
        snapshot,
        events: items,
        backupSnapshotPath: null,
        backupEventsPath: null
      };
      await this.commitTransactionUnlocked(
        transaction,
        snapshotSource,
        eventsSource
      );
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

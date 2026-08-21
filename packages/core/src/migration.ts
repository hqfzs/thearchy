import { DEFAULT_BUDGETS } from "./budget.js";
import { DEFAULT_MODEL_POLICY } from "./policy.js";
import { createHash } from "node:crypto";
import type {
  AgentInstanceRecord,
  AgentLease,
  EffectiveRunMode,
  RunSnapshot
} from "./types.js";

export interface MigrationResult {
  snapshot: RunSnapshot;
  migrated: boolean;
  sourceSchemaVersion: unknown;
}

function taskFingerprint(task: unknown): string {
  const normalized =
    typeof task === "string"
      ? task.trim().replace(/\s+/g, " ").toLowerCase()
      : "unknown-task";
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeLease(
  value: Partial<AgentLease> & { instanceId: string; roleId: string }
): AgentLease {
  const claimedAt = value.claimedAt ?? new Date(0).toISOString();
  return {
    instanceId: value.instanceId,
    roleId: value.roleId,
    model: value.model ?? "unknown",
    reasoningEffort: value.reasoningEffort ?? "unknown",
    claimedAt,
    lastHeartbeatAt: value.lastHeartbeatAt ?? claimedAt,
    // Unknown v1 leases expire immediately and require explicit recovery.
    expiresAt: value.expiresAt ?? claimedAt
  };
}

function normalizeInstance(
  value: Partial<AgentInstanceRecord> & { instanceId: string; roleId: string }
): AgentInstanceRecord {
  return {
    instanceId: value.instanceId,
    roleId: value.roleId,
    model: value.model ?? "unknown",
    reasoningEffort: value.reasoningEffort ?? "unknown"
  };
}

function normalizeV2(raw: Record<string, unknown>): RunSnapshot {
  const mode: EffectiveRunMode = raw.mode === "full" ? "full" : "light";
  return {
    ...(raw as unknown as RunSnapshot),
    schemaVersion: 2,
    taskFingerprint:
      (raw.taskFingerprint as string | undefined) ?? taskFingerprint(raw.task),
    modelPolicy:
      (raw.modelPolicy as RunSnapshot["modelPolicy"] | undefined) ??
      DEFAULT_MODEL_POLICY,
    templatePermissions:
      (raw.templatePermissions as RunSnapshot["templatePermissions"] | undefined) ??
      {
        network: "approval",
        dependencyInstall: "approval",
        destructive: "approval",
        externalWrite: "approval",
        sensitiveRead: "deny"
      },
    allowedGovernance: (raw.allowedGovernance as string[] | undefined) ?? [],
    allowedSpecialists: (raw.allowedSpecialists as string[] | undefined) ?? [],
    participants: (raw.participants as string[] | undefined) ?? [],
    activeAgents: (
      (raw.activeAgents as Array<
        Partial<AgentLease> & { instanceId: string; roleId: string }
      > | undefined) ?? []
    ).map(normalizeLease),
    agentInstances: (
      (raw.agentInstances as Array<
        Partial<AgentInstanceRecord> & { instanceId: string; roleId: string }
      > | undefined) ?? []
    ).map(normalizeInstance),
    artifacts: (raw.artifacts as RunSnapshot["artifacts"] | undefined) ?? [],
    decisions: (raw.decisions as RunSnapshot["decisions"] | undefined) ?? [],
    candidates: (raw.candidates as RunSnapshot["candidates"] | undefined) ?? [],
    approvals: (raw.approvals as RunSnapshot["approvals"] | undefined) ?? {},
    verificationCompleted:
      (raw.verificationCompleted as boolean | undefined) ?? false,
    resultReviewCompleted:
      (raw.resultReviewCompleted as boolean | undefined) ?? false,
    modeBudgets:
      (raw.modeBudgets as RunSnapshot["modeBudgets"] | undefined) ?? {
        light: DEFAULT_BUDGETS.light,
        full: DEFAULT_BUDGETS.full
      },
    budget: {
      ...DEFAULT_BUDGETS[mode],
      ...((raw.budget as Partial<RunSnapshot["budget"]> | undefined) ?? {})
    }
  };
}

function recoverySnapshot(
  raw: Record<string, unknown>,
  sourceSchemaVersion: unknown,
  reason: string
): RunSnapshot {
  const now = new Date().toISOString();
  const mode: EffectiveRunMode = raw.mode === "full" ? "full" : "light";
  return {
    id: typeof raw.id === "string" ? raw.id : `recovery-${Date.now()}`,
    schemaVersion: 2,
    task: typeof raw.task === "string" ? raw.task : "Unsupported run snapshot",
    taskFingerprint: taskFingerprint(raw.task),
    templateId:
      typeof raw.templateId === "string" ? raw.templateId : "unknown-template",
    requestedMode:
      raw.requestedMode === "full" || raw.requestedMode === "light"
        ? raw.requestedMode
        : "auto",
    mode,
    risk: {
      score: 0,
      level: "low",
      effectiveMode: mode,
      reasons: ["snapshot migration failed"]
    },
    state: "blocked",
    planReworks: 0,
    resultReworks: 0,
    verificationCompleted: false,
    resultReviewCompleted: false,
    modelPolicy: DEFAULT_MODEL_POLICY,
    templatePermissions: {
      network: "deny",
      dependencyInstall: "deny",
      destructive: "deny",
      externalWrite: "deny",
      sensitiveRead: "deny"
    },
    allowedGovernance: [],
    allowedSpecialists: [],
    participants: [],
    activeAgents: [],
    agentInstances: [],
    artifacts: [],
    decisions: [],
    candidates: [],
    approvals: {},
    dirtyWorkingTree: false,
    modeBudgets: {
      light: DEFAULT_BUDGETS.light,
      full: DEFAULT_BUDGETS.full
    },
    budget: DEFAULT_BUDGETS[mode],
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : now,
    updatedAt: now,
    readOnlyRecovery: { reason, sourceSchemaVersion }
  };
}

export function migrateRunSnapshot(input: unknown): MigrationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      snapshot: recoverySnapshot({}, undefined, "Snapshot is not an object"),
      migrated: true,
      sourceSchemaVersion: undefined
    };
  }
  const raw = input as Record<string, unknown>;
  const version = raw.schemaVersion;
  try {
    if (version === 2) {
      return {
        snapshot: normalizeV2(raw),
        migrated: false,
        sourceSchemaVersion: version
      };
    }
    if (version === 1) {
      return {
        snapshot: normalizeV2(raw),
        migrated: true,
        sourceSchemaVersion: version
      };
    }
    return {
      snapshot: recoverySnapshot(
        raw,
        version,
        `Unsupported schema version: ${String(version)}`
      ),
      migrated: true,
      sourceSchemaVersion: version
    };
  } catch (error) {
    return {
      snapshot: recoverySnapshot(
        raw,
        version,
        error instanceof Error ? error.message : String(error)
      ),
      migrated: true,
      sourceSchemaVersion: version
    };
  }
}

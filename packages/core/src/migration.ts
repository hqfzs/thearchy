import { DEFAULT_BUDGETS } from "./budget.js";
import { DEFAULT_MODEL_POLICY } from "./policy.js";
import { createHash } from "node:crypto";
import type {
  AgentInstanceRecord,
  AgentLease,
  EffectiveRunMode,
  RiskAssessment,
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

function normalizeRisk(
  value: unknown,
  mode: EffectiveRunMode,
  requestedMode: RunSnapshot["requestedMode"]
): RiskAssessment {
  const risk =
    value && typeof value === "object"
      ? (value as Partial<RiskAssessment>)
      : {};
  const level =
    risk.level === "high" || risk.level === "medium" ? risk.level : "low";
  const routing =
    risk.routing ??
    (requestedMode !== "auto"
      ? "explicit"
      : level === "low"
        ? "automatic-light"
        : level === "medium"
          ? "confirm"
          : "forced-full");
  const legacyScore = typeof risk.score === "number" ? risk.score : 0;
  const impactScore = Math.min(
    4,
    Math.max(
      0,
      typeof risk.impactScore === "number" ? risk.impactScore : legacyScore
    )
  );
  const complexityScore = Math.min(
    3,
    Math.max(
      0,
      typeof risk.complexityScore === "number" ? risk.complexityScore : 0
    )
  );
  const uncertaintyScore = Math.min(
    3,
    Math.max(
      0,
      typeof risk.uncertaintyScore === "number" ? risk.uncertaintyScore : 0
    )
  );
  const operationalScore = Math.min(
    2,
    Math.max(
      0,
      typeof risk.operationalScore === "number" ? risk.operationalScore : 0
    )
  );
  const totalScore =
    typeof risk.totalScore === "number"
      ? Math.min(12, Math.max(0, risk.totalScore))
      : Math.min(
          12,
          impactScore + complexityScore + uncertaintyScore + operationalScore
        );
  return {
    impactScore,
    complexityScore,
    uncertaintyScore,
    operationalScore,
    totalScore,
    score: totalScore,
    level,
    effectiveMode:
      risk.effectiveMode === "full" || risk.effectiveMode === "light"
        ? risk.effectiveMode
        : mode,
    routing,
    requiresModeApproval:
      typeof risk.requiresModeApproval === "boolean"
        ? risk.requiresModeApproval
        : routing === "confirm",
    reasons: Array.isArray(risk.reasons)
      ? risk.reasons.map((reason) => String(reason))
      : [],
    context:
      risk.context && typeof risk.context === "object"
        ? {
            gitStatus:
              risk.context.gitStatus === "clean" ||
              risk.context.gitStatus === "dirty"
                ? risk.context.gitStatus
                : "unavailable",
            gitAvailable: Boolean(risk.context.gitAvailable),
            dirtyWorkingTree: Boolean(risk.context.dirtyWorkingTree),
            dirtyFileCount:
              typeof risk.context.dirtyFileCount === "number"
                ? risk.context.dirtyFileCount
                : 0,
            sensitivePathsChanged: Boolean(
              risk.context.sensitivePathsChanged
            ),
            hasVerification: Boolean(risk.context.hasVerification),
            verificationCommands: Array.isArray(
              risk.context.verificationCommands
            )
              ? risk.context.verificationCommands
              : [],
            projectKinds: Array.isArray(risk.context.projectKinds)
              ? risk.context.projectKinds.map((kind) => String(kind))
              : [],
            ...(typeof risk.context.baselineCommit === "string"
              ? { baselineCommit: risk.context.baselineCommit }
              : {}),
            ...(typeof risk.context.templateId === "string"
              ? { templateId: risk.context.templateId }
              : {})
          }
        : {
            gitStatus: "unavailable",
            gitAvailable: false,
            dirtyWorkingTree: false,
            dirtyFileCount: 0,
            sensitivePathsChanged: false,
            hasVerification: false,
            verificationCommands: [],
            projectKinds: []
          }
  };
}

function normalizeV3(raw: Record<string, unknown>): RunSnapshot {
  const mode: EffectiveRunMode = raw.mode === "full" ? "full" : "light";
  const requestedMode: RunSnapshot["requestedMode"] =
    raw.requestedMode === "full" || raw.requestedMode === "light"
      ? raw.requestedMode
      : "auto";
  const verificationStatus =
    raw.verificationStatus === "passed" ||
    raw.verificationStatus === "failed"
      ? raw.verificationStatus
      : raw.verificationCompleted === true
        ? "passed"
        : "unverified";
  return {
    ...(raw as unknown as RunSnapshot),
    schemaVersion: 3,
    requestedMode,
    risk: normalizeRisk(raw.risk, mode, requestedMode),
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
    artifacts: (
      (raw.artifacts as Array<
        Partial<RunSnapshot["artifacts"][number]> & {
          id: string;
          roleId: string;
          path: string;
          sha256: string;
          createdAt: string;
          final: boolean;
        }
      > | undefined) ?? []
    ).map((artifact) => ({
      ...artifact,
      instanceId:
        typeof artifact.instanceId === "string"
          ? artifact.instanceId
          : artifact.roleId.startsWith("governance.")
            ? "root-main"
            : "legacy-unknown"
    })),
    decisions: (raw.decisions as RunSnapshot["decisions"] | undefined) ?? [],
    candidates: (raw.candidates as RunSnapshot["candidates"] | undefined) ?? [],
    approvals: (raw.approvals as RunSnapshot["approvals"] | undefined) ?? {},
    verificationCompleted: verificationStatus === "passed",
    verificationAttemptStatus:
      raw.verificationAttemptStatus === "submitted"
        ? "submitted"
        : "not_started",
    verificationStatus,
    verificationResults:
      (raw.verificationResults as RunSnapshot["verificationResults"] | undefined) ??
      [],
    resultReviewCompleted:
      (raw.resultReviewCompleted as boolean | undefined) ?? false,
    requiredVerification:
      (raw.requiredVerification as RunSnapshot["requiredVerification"] | undefined) ??
      [],
    modeBudgets:
      (raw.modeBudgets as RunSnapshot["modeBudgets"] | undefined) ?? {
        light: DEFAULT_BUDGETS.light,
        full: DEFAULT_BUDGETS.full
      },
    budget: {
      ...DEFAULT_BUDGETS[mode],
      ...((raw.budget as Partial<RunSnapshot["budget"]> | undefined) ?? {})
    },
    activeElapsedMs:
      typeof raw.activeElapsedMs === "number"
        ? Math.max(0, raw.activeElapsedMs)
        : Math.max(
            0,
            Date.parse(
              typeof raw.updatedAt === "string"
                ? raw.updatedAt
                : new Date().toISOString()
            ) -
              Date.parse(
                typeof raw.startedAt === "string"
                  ? raw.startedAt
                  : new Date().toISOString()
              )
          ),
    budgetExtensions:
      (raw.budgetExtensions as RunSnapshot["budgetExtensions"] | undefined) ?? [],
    ...(typeof raw.activeSince === "string"
      ? { activeSince: raw.activeSince }
      : {}),
    ...(typeof raw.pausedAt === "string" ? { pausedAt: raw.pausedAt } : {})
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
    schemaVersion: 3,
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
      impactScore: 0,
      complexityScore: 0,
      uncertaintyScore: 0,
      operationalScore: 0,
      totalScore: 0,
      score: 0,
      level: "low",
      effectiveMode: mode,
      routing: "automatic-light",
      requiresModeApproval: false,
      reasons: ["snapshot migration failed"],
      context: {
        gitStatus: "unavailable",
        gitAvailable: false,
        dirtyWorkingTree: false,
        dirtyFileCount: 0,
        sensitivePathsChanged: false,
        hasVerification: false,
        verificationCommands: [],
        projectKinds: []
      }
    },
    state: "blocked",
    planReworks: 0,
    resultReworks: 0,
    verificationCompleted: false,
    verificationAttemptStatus: "not_started",
    verificationStatus: "unverified",
    verificationResults: [],
    resultReviewCompleted: false,
    modelPolicy: DEFAULT_MODEL_POLICY,
    requiredVerification: [],
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
    activeElapsedMs: 0,
    budgetExtensions: [],
    pausedAt: now,
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
    if (version === 3) {
      return {
        snapshot: normalizeV3(raw),
        migrated: false,
        sourceSchemaVersion: version
      };
    }
    if (version === 1 || version === 2) {
      return {
        snapshot: normalizeV3(raw),
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

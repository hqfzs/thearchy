import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateHostRuntimeReport } from "./capabilities.js";
import { detectVerificationCommands } from "./commands.js";
import {
  applyRiskSignal,
  assessRisk,
  inspectRiskContext
} from "./risk.js";
import { resolveBudget } from "./budget.js";
import { inspectGitBaseline } from "./git.js";
import { DEFAULT_MODEL_POLICY } from "./policy.js";
import { ROLE_BY_ID } from "./roles.js";
import {
  assertRunActive,
  assertTransition,
  isRunClockPaused,
  nextAction
} from "./state-machine.js";
import { nextEvent, RunStore } from "./store.js";
import { sha256File } from "./security.js";
import { validateVerificationResult } from "./verification.js";
import type {
  ApprovalGate,
  ArtifactRecord,
  DecisionKind,
  DecisionOption,
  DecisionRequest,
  ModelPolicy,
  NextAction,
  OperationType,
  PendingOperation,
  RejectionGate,
  RunBudget,
  RunMode,
  RiskSignalType,
  RunSnapshot,
  RunState,
  TeamTemplate,
  WorkspaceCandidate
} from "./types.js";

function runId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

function taskFingerprint(task: string): string {
  return createHash("sha256")
    .update(task.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex");
}

function transition(snapshot: RunSnapshot, state: RunState): void {
  assertTransition(snapshot.state, state);
  const now = new Date().toISOString();
  if (snapshot.activeSince && !isRunClockPaused(snapshot.state)) {
    snapshot.activeElapsedMs += Math.max(
      0,
      Date.parse(now) - Date.parse(snapshot.activeSince)
    );
  }
  snapshot.previousState = snapshot.state;
  snapshot.state = state;
  if (isRunClockPaused(state)) {
    delete snapshot.activeSince;
    snapshot.pausedAt = now;
  } else {
    snapshot.activeSince = now;
    delete snapshot.pausedAt;
  }
  if (state === "completed") {
    snapshot.completedAt = now;
  }
}

export interface StartRunInput {
  task: string;
  template: TeamTemplate;
  requestedMode: RunMode;
  cwd: string;
  budgetOverrides?: Partial<RunBudget>;
  allowDuplicate?: boolean;
}

export interface SubmitArtifactInput {
  runId: string;
  roleId: string;
  instanceId: string;
  artifactPath: string;
  final?: boolean;
  actor?: string;
  rootManaged?: boolean;
}

export interface ClaimAgentInput {
  runId: string;
  roleId: string;
  instanceId: string;
  model: string;
  reasoningEffort: string;
  actor?: string;
}

export interface RequestOperationInput {
  runId: string;
  type: OperationType;
  summary: string;
  actor?: string;
}

export interface ReassessRiskInput {
  runId: string;
  signal: RiskSignalType;
  summary: string;
  actor?: string;
}

export class Coordinator {
  constructor(readonly store: RunStore) {}

  async start(input: StartRunInput): Promise<RunSnapshot> {
    const baseline = inspectGitBaseline(input.cwd);
    const verificationCommands = baseline.repositoryRoot
      ? await detectVerificationCommands(baseline.repositoryRoot)
      : [];
    const risk = assessRisk(
      input.task,
      input.requestedMode,
      inspectRiskContext(
        input.cwd,
        input.template.metadata.id,
        baseline,
        verificationCommands
      )
    );
    const fingerprint = taskFingerprint(input.task);
    if (!input.allowDuplicate) {
      const existing = await this.store.findActiveRun({
        repositoryRoot: baseline.repositoryRoot,
        taskFingerprint: fingerprint,
        templateId: input.template.metadata.id
      });
      if (existing) {
        return this.store.update(existing.id, (_snapshot, events) =>
          nextEvent(events, existing.id, "run.resumed", "system", {
            reason: "duplicate-start-prevented",
            taskFingerprint: fingerprint
          })
        );
      }
    }
    const id = runId();
    const modeBudgets = {
      light: resolveBudget(
        "light",
        input.template.spec.profiles.light,
        input.budgetOverrides
      ),
      full: resolveBudget(
        "full",
        input.template.spec.profiles.full,
        input.budgetOverrides
      )
    };
    const budget = modeBudgets[risk.effectiveMode];
    const now = new Date().toISOString();
    const snapshot: RunSnapshot = {
      id,
      schemaVersion: 3,
      task: input.task,
      taskFingerprint: fingerprint,
      templateId: input.template.metadata.id,
      requestedMode: input.requestedMode,
      mode: risk.effectiveMode,
      risk,
      state: "created",
      planReworks: 0,
      resultReworks: 0,
      verificationCompleted: false,
      verificationAttemptStatus: "not_started",
      verificationStatus: "unverified",
      verificationResults: [],
      resultReviewCompleted: false,
      modelPolicy: DEFAULT_MODEL_POLICY,
      requiredVerification: [...input.template.spec.verification.required],
      templatePermissions: { ...input.template.spec.permissions },
      allowedGovernance: [...input.template.spec.governance],
      allowedSpecialists: [...input.template.spec.specialists],
      participants: [],
      activeAgents: [],
      agentInstances: [],
      artifacts: [],
      decisions: [],
      candidates: [],
      approvals:
        input.requestedMode === "auto" ? {} : { mode: now },
      dirtyWorkingTree: baseline.dirty,
      modeBudgets,
      budget,
      activeElapsedMs: 0,
      activeSince: now,
      budgetExtensions: [],
      startedAt: now,
      updatedAt: now
    };
    if (baseline.commit) snapshot.baselineCommit = baseline.commit;
    if (baseline.repositoryRoot) snapshot.repositoryRoot = baseline.repositoryRoot;

    await this.store.create(snapshot, {
      sequence: 1,
      runId: id,
      type: "run.started",
      timestamp: now,
      actor: "system",
      data: {
        templateId: snapshot.templateId,
        mode: snapshot.mode,
        risk: snapshot.risk,
        baselineCommit: snapshot.baselineCommit ?? null,
        dirtyWorkingTree: snapshot.dirtyWorkingTree
      }
    });
    return snapshot;
  }

  async status(id: string): Promise<RunSnapshot> {
    return this.store.load(id);
  }

  async extendBudget(
    id: string,
    minutes: number,
    actor = "user"
  ): Promise<RunSnapshot> {
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
      throw new Error("Budget extension must be an integer from 1 to 1440 minutes");
    }
    return this.store.update(id, (snapshot, events) => {
      if (snapshot.readOnlyRecovery) {
        throw new Error(
          `Run ${snapshot.id} is in read-only recovery: ${snapshot.readOnlyRecovery.reason}`
        );
      }
      if (["completed", "cancelled"].includes(snapshot.state)) {
        throw new Error(`Run ${snapshot.id} is terminal: ${snapshot.state}`);
      }
      snapshot.budget.timeoutMinutes += minutes;
      snapshot.modeBudgets[snapshot.mode].timeoutMinutes += minutes;
      const createdAt = new Date().toISOString();
      snapshot.budgetExtensions.push({ minutes, actor, createdAt });
      return nextEvent(events, id, "budget.extended", actor, {
        minutes,
        timeoutMinutes: snapshot.budget.timeoutMinutes
      });
    });
  }

  async registerCapabilities(
    id: string,
    input: unknown,
    actor = "main"
  ): Promise<RunSnapshot> {
    const report = validateHostRuntimeReport(input);
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      if (
        snapshot.runtimeCapabilities &&
        snapshot.runtimeCapabilities.reportHash !== report.reportHash &&
        snapshot.activeAgents.length > 0
      ) {
        throw new Error(
          "Runtime capabilities cannot change while child agents are active"
        );
      }
      if (snapshot.runtimeCapabilities?.reportHash === report.reportHash) {
        return [];
      }
      snapshot.runtimeCapabilities = report;
      snapshot.runtimeCapabilitiesRegisteredAt = new Date().toISOString();
      return nextEvent(events, id, "host.capabilities.recorded", actor, {
        host: report.host,
        platform: report.platform,
        checkedAt: report.checkedAt,
        capabilities: report.capabilities,
        reportHash: report.reportHash
      });
    });
  }

  async next(id: string): Promise<NextAction> {
    let snapshot = await this.store.load(id);
    this.ensureCoordinationFields(snapshot);
    if (
      snapshot.activeAgents.some(
        (lease) => Date.parse(lease.expiresAt) <= Date.now()
      )
    ) {
      snapshot = await this.recoverStale(id);
    }
    assertRunActive(snapshot);
    return nextAction(snapshot);
  }

  async claim(
    id: string,
    roleId: string,
    instanceId: string,
    model: string,
    reasoningEffort: string,
    actor = "main"
  ): Promise<RunSnapshot> {
    if (!ROLE_BY_ID.has(roleId)) throw new Error(`Unknown role: ${roleId}`);
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(instanceId)) {
      throw new Error("Agent instance id must use letters, numbers, dot, underscore, or hyphen");
    }
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      this.assertRoleAllowed(snapshot, roleId);
      snapshot.runtimeCapabilitiesRegisteredAt = new Date().toISOString();
      this.assertRuntimeCapabilities(snapshot);
      if (
        model !== snapshot.modelPolicy.model ||
        reasoningEffort !== snapshot.modelPolicy.reasoningEffort
      ) {
        throw new Error(
          `Child agent must use ${snapshot.modelPolicy.model} with ${snapshot.modelPolicy.reasoningEffort} reasoning`
        );
      }
      if (snapshot.activeAgents.some((lease) => lease.instanceId === instanceId)) {
        throw new Error(`Agent instance is already active: ${instanceId}`);
      }
      if (snapshot.activeAgents.length >= snapshot.budget.maxConcurrency) {
        throw new Error(
          `Run concurrency budget exceeded (${snapshot.budget.maxConcurrency})`
        );
      }

      const existing = snapshot.agentInstances.find(
        (instance) => instance.instanceId === instanceId
      );
      if (existing && existing.roleId !== roleId) {
        throw new Error(
          `Agent instance ${instanceId} is already bound to ${existing.roleId}`
        );
      }
      const role = ROLE_BY_ID.get(roleId)!;
      if (!existing) {
        if (snapshot.agentInstances.length >= snapshot.budget.maxAgents) {
          throw new Error(`Run agent budget exceeded (${snapshot.budget.maxAgents})`);
        }
        if (roleId === "expert.builder") {
          const builderCount = snapshot.agentInstances.filter(
            (instance) => instance.roleId === "expert.builder"
          ).length;
          if (builderCount >= snapshot.budget.maxCompetingImplementations) {
            throw new Error(
              `Competing implementation budget exceeded (${snapshot.budget.maxCompetingImplementations})`
            );
          }
        }
      }

      const claimedAt = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + snapshot.budget.leaseTimeoutMinutes * 60_000
      ).toISOString();
      snapshot.activeAgents.push({
        instanceId,
        roleId,
        model,
        reasoningEffort,
        claimedAt,
        lastHeartbeatAt: claimedAt,
        expiresAt
      });
      if (!existing) {
        snapshot.agentInstances.push({
          instanceId,
          roleId,
          model,
          reasoningEffort
        });
      }
      if (!snapshot.participants.includes(roleId)) snapshot.participants.push(roleId);
      const claimed = nextEvent(events, id, "agent.claimed", actor, {
        instanceId,
        roleId,
        model,
        reasoningEffort,
        expiresAt,
        activeAgents: snapshot.activeAgents.length
      });
      const verified = nextEvent(
        [...events, claimed],
        id,
        "model.verified",
        "system",
        { instanceId, roleId, model, reasoningEffort }
      );
      return [claimed, verified];
    });
  }

  async release(
    id: string,
    instanceId: string,
    actor = "main"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      const lease = snapshot.activeAgents.find(
        (item) => item.instanceId === instanceId
      );
      if (!lease) throw new Error(`Agent instance is not active: ${instanceId}`);
      snapshot.activeAgents = snapshot.activeAgents.filter(
        (item) => item.instanceId !== instanceId
      );
      return nextEvent(events, id, "agent.released", actor, {
        instanceId,
        roleId: lease.roleId,
        activeAgents: snapshot.activeAgents.length
      });
    });
  }

  async heartbeat(
    id: string,
    instanceId: string,
    actor = "main"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      const lease = snapshot.activeAgents.find(
        (item) => item.instanceId === instanceId
      );
      if (!lease) throw new Error(`Agent instance is not active: ${instanceId}`);
      const now = new Date();
      lease.lastHeartbeatAt = now.toISOString();
      lease.expiresAt = new Date(
        now.getTime() + snapshot.budget.leaseTimeoutMinutes * 60_000
      ).toISOString();
      snapshot.runtimeCapabilitiesRegisteredAt = now.toISOString();
      return nextEvent(events, id, "agent.heartbeat", actor, {
        instanceId,
        roleId: lease.roleId,
        expiresAt: lease.expiresAt
      });
    });
  }

  async recoverStale(id: string, actor = "system"): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      const now = Date.now();
      const expired = snapshot.activeAgents.filter(
        (lease) => Date.parse(lease.expiresAt) <= now
      );
      if (expired.length === 0) {
        throw new Error("No stale agent leases were found");
      }
      snapshot.activeAgents = snapshot.activeAgents.filter(
        (lease) => Date.parse(lease.expiresAt) > now
      );
      const emitted = expired.map((lease, index) =>
        nextEvent(
          [...events, ...expired.slice(0, index).map(() => ({} as never))],
          id,
          "agent.expired",
          actor,
          {
            instanceId: lease.instanceId,
            roleId: lease.roleId,
            expiresAt: lease.expiresAt
          }
        )
      );
      const decision = this.createDecision(
        snapshot,
        "conflict",
        "一个或多个子 Agent 租约已过期，如何继续？",
        [
          {
            id: "retry",
            label: "重试原任务",
            description: "释放过期实例并重新派遣相同角色。",
            recommended: true
          },
          {
            id: "replace",
            label: "更换 Agent",
            description: "使用新实例重新执行受影响任务。",
            recommended: false
          },
          {
            id: "cancel",
            label: "取消运行",
            description: "保留现场并终止本次运行。",
            recommended: false
          }
        ],
        {
          reason: "stale-agent-leases",
          expiredInstances: expired.map((lease) => lease.instanceId),
          returnState: snapshot.state
        }
      );
      const previous = snapshot.state;
      transition(snapshot, "awaiting_conflict_decision");
      const requested = nextEvent(
        [...events, ...emitted],
        id,
        "decision.requested",
        "system",
        { decision }
      );
      emitted.push(requested);
      emitted.push(
        nextEvent(
          [...events, ...emitted],
          id,
          "run.transitioned",
          "system",
          { from: previous, to: snapshot.state }
        )
      );
      return emitted;
    });
  }

  async requestOperation(input: RequestOperationInput): Promise<RunSnapshot> {
    if (!input.summary.trim()) throw new Error("Operation summary is required");
    return this.store.update(input.runId, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      if (!["executing", "integrating", "verification"].includes(snapshot.state)) {
        throw new Error(
          `Risk operations cannot be requested while run is ${snapshot.state}`
        );
      }
      if (this.pendingDecision(snapshot)) {
        throw new Error("Resolve the pending decision before requesting an operation");
      }
      const permission = this.operationPermission(snapshot, input.type);
      if (permission === "deny") {
        throw new Error(`Operation ${input.type} is denied by the template`);
      }
      const operation: PendingOperation = {
        id: `operation-${snapshot.decisions.length + 1}`,
        type: input.type,
        summary: input.summary,
        requestedAt: new Date().toISOString(),
        returnState: snapshot.state
      };
      snapshot.pendingOperation = operation;
      const decision = this.createDecision(
        snapshot,
        "risk",
        `是否允许执行高风险操作：${input.summary}`,
        [
          {
            id: "approve-once",
            label: "仅本次允许",
            description: "允许当前操作一次，不扩大后续权限。",
            recommended: false
          },
          {
            id: "deny",
            label: "拒绝操作",
            description: "不执行当前操作并返回原阶段。",
            recommended: true
          },
          {
            id: "cancel",
            label: "取消运行",
            description: "保留现场并终止本次运行。",
            recommended: false
          }
        ],
        { operation, returnState: snapshot.state }
      );
      const previous = snapshot.state;
      transition(snapshot, "awaiting_risk_approval");
      const operationEvent = nextEvent(
        events,
        snapshot.id,
        "operation.requested",
        input.actor ?? "main",
        { operation }
      );
      const decisionEvent = nextEvent(
        [...events, operationEvent],
        snapshot.id,
        "decision.requested",
        "system",
        { decision }
      );
      return [
        operationEvent,
        decisionEvent,
        nextEvent(
          [...events, operationEvent, decisionEvent],
          snapshot.id,
          "run.transitioned",
          "system",
          { from: previous, to: snapshot.state }
        )
      ];
    });
  }

  async reassessRisk(input: ReassessRiskInput): Promise<RunSnapshot> {
    if (!input.summary.trim()) throw new Error("Risk summary is required");
    return this.store.update(input.runId, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      if (
        ![
          "classified",
          "planning",
          "plan_review",
          "awaiting_plan_approval",
          "dispatching",
          "executing",
          "verification"
        ].includes(snapshot.state)
      ) {
        throw new Error(`Risk cannot be reassessed while run is ${snapshot.state}`);
      }
      if (this.pendingDecision(snapshot)) {
        throw new Error("Resolve the pending decision before reassessing risk");
      }
      if (snapshot.activeAgents.length > 0) {
        throw new Error(
          "Release active child agents before reassessing runtime risk"
        );
      }
      const previousRisk = snapshot.risk;
      snapshot.risk = applyRiskSignal(snapshot.risk, input.signal);
      const reassessed = nextEvent(
        events,
        snapshot.id,
        "risk.reassessed",
        input.actor ?? "main",
        {
          signal: input.signal,
          summary: input.summary,
          previousRisk,
          risk: snapshot.risk
        }
      );
      if (snapshot.mode !== "light" || snapshot.risk.level !== "high") {
        return reassessed;
      }
      const returnState = snapshot.state;
      const decision = this.createDecision(
        snapshot,
        "escalation",
        "轻量运行发现高风险，是否升级为完整模式？",
        [
          {
            id: "upgrade-full",
            label: "升级完整模式",
            description: "保留现有产物，返回规划阶段补充完整审查。",
            recommended: true
          },
          {
            id: "cancel",
            label: "取消运行",
            description: "保留现场并停止，不继续以轻量模式执行。",
            recommended: false
          }
        ],
        { signal: input.signal, summary: input.summary, returnState }
      );
      transition(snapshot, "awaiting_escalation_decision");
      const requested = nextEvent(
        [...events, reassessed],
        snapshot.id,
        "mode.escalation.requested",
        "system",
        { decision }
      );
      return [
        reassessed,
        requested,
        nextEvent(
          [...events, reassessed, requested],
          snapshot.id,
          "run.transitioned",
          "system",
          { from: returnState, to: snapshot.state }
        )
      ];
    });
  }

  async decide(
    id: string,
    requestId: string,
    choiceId: string,
    actor = "user"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      if (snapshot.runtimeCapabilities) {
        snapshot.runtimeCapabilitiesRegisteredAt = new Date().toISOString();
      }
      const decision = snapshot.decisions.find(
        (item) => item.id === requestId && item.status === "pending"
      );
      if (!decision) throw new Error(`Pending decision not found: ${requestId}`);
      if (!decision.options.some((option) => option.id === choiceId)) {
        throw new Error(`Invalid choice ${choiceId} for decision ${requestId}`);
      }
      decision.status = "resolved";
      decision.selectedOption = choiceId;
      decision.resolvedAt = new Date().toISOString();
      const previous = snapshot.state;
      this.applyDecision(snapshot, decision, choiceId);
      const resolved = nextEvent(events, id, "decision.resolved", actor, {
        requestId,
        kind: decision.kind,
        choiceId
      });
      return [
        resolved,
        nextEvent(
          [...events, resolved],
          id,
          "run.transitioned",
          "system",
          { from: previous, to: snapshot.state }
        )
      ];
    });
  }

  async submit(input: SubmitArtifactInput): Promise<RunSnapshot> {
    if (!ROLE_BY_ID.has(input.roleId)) {
      throw new Error(`Unknown role: ${input.roleId}`);
    }
    const artifactPath = resolve(input.artifactPath);
    const sha256 = await sha256File(artifactPath);
    let verificationInput: unknown;
    if (input.roleId === "expert.tester") {
      try {
        verificationInput = JSON.parse(await readFile(artifactPath, "utf8"));
      } catch (error) {
        throw new Error(
          `Tester artifact must be valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return this.store.update(input.runId, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      if (snapshot.runtimeCapabilities) {
        snapshot.runtimeCapabilitiesRegisteredAt = new Date().toISOString();
      }
      this.assertRoleAllowed(snapshot, input.roleId);
      const rootManaged = input.rootManaged ?? false;
      if (rootManaged && !this.canRootManage(snapshot, input.roleId)) {
        throw new Error(`Role ${input.roleId} cannot be managed by the root agent`);
      }
      const lease = rootManaged
        ? undefined
        : snapshot.activeAgents.find(
            (item) =>
              item.instanceId === input.instanceId && item.roleId === input.roleId
          );
      if (!rootManaged && !lease) {
        throw new Error(
          `Agent ${input.instanceId} must claim role ${input.roleId} before submitting`
        );
      }
      const remainingAgents = rootManaged
        ? snapshot.activeAgents
        : snapshot.activeAgents.filter(
            (item) => item.instanceId !== input.instanceId
          );
      if (
        snapshot.state === "executing" &&
        (input.final ?? false) &&
        remainingAgents.length > 0
      ) {
        throw new Error(
          "Cannot finish execution while other agent instances are still active"
        );
      }
      const artifact: ArtifactRecord = {
        id: `artifact-${snapshot.artifacts.length + 1}`,
        roleId: input.roleId,
        instanceId: input.instanceId,
        path: artifactPath,
        sha256,
        createdAt: new Date().toISOString(),
        final: input.final ?? false,
        ...(input.roleId === "expert.tester"
          ? {
              verification: validateVerificationResult(
                verificationInput,
                snapshot,
                input.instanceId
              )
            }
          : {})
      };
      snapshot.artifacts.push(artifact);
      if (artifact.verification) {
        snapshot.verificationAttemptStatus = "submitted";
        snapshot.verificationStatus = artifact.verification.status;
        snapshot.verificationResults.push(artifact.verification);
      }
      snapshot.activeAgents = remainingAgents;

      const emitted = [
        nextEvent(
          events,
          snapshot.id,
          "artifact.submitted",
          input.actor ?? (rootManaged ? "root-main" : input.instanceId),
          { artifact, instanceId: input.instanceId, rootManaged }
        )
      ];
      const emit = (
        type: Parameters<typeof nextEvent>[2],
        actor: string,
        data: Record<string, unknown>
      ): void => {
        emitted.push(
          nextEvent([...events, ...emitted], snapshot.id, type, actor, data)
        );
      };
      if (!rootManaged) {
        emitted.push(
          nextEvent(
            [...events, ...emitted],
            snapshot.id,
            "agent.released",
            "system",
            {
              instanceId: input.instanceId,
              roleId: input.roleId,
              activeAgents: snapshot.activeAgents.length
            }
          )
        );
      }
      if (artifact.verification) {
        emit("verification.validated", "system", {
          artifactId: artifact.id,
          attempt: artifact.verification.attempt,
          status: artifact.verification.status,
          verifierInstanceId: artifact.verification.verifierInstanceId,
          implementerInstanceIds: artifact.verification.implementerInstanceIds
        });
      }
      const previous = snapshot.state;
      const advance = this.stateAfterSubmission(snapshot, input.roleId, input.final ?? false);
      if (advance) {
        transition(snapshot, advance);
        emit("run.transitioned", "system", {
          from: previous,
          to: snapshot.state
        });
        if (
          previous === "created" &&
          snapshot.requestedMode === "auto" &&
          snapshot.risk.requiresModeApproval
        ) {
          const classifiedState = snapshot.state;
          const decision = this.createDecision(
            snapshot,
            "mode",
            "请选择本次运行模式",
            [
              {
                id: snapshot.risk.effectiveMode,
                label:
                  snapshot.risk.effectiveMode === "full"
                    ? "完整模式"
                    : "轻量模式",
                description: `根据风险评分 ${snapshot.risk.score} 推荐。`,
                recommended: true
              },
              {
                id: snapshot.risk.effectiveMode === "full" ? "light" : "full",
                label:
                  snapshot.risk.effectiveMode === "full"
                    ? "轻量模式"
                    : "完整模式",
                description:
                  snapshot.risk.effectiveMode === "full"
                    ? "减少 Agent 和质量门，执行更快。"
                    : "启用多方案、专项审查和隔离实现。",
                recommended: false
              }
            ],
            {
              risk: snapshot.risk,
              recommendedMode: snapshot.risk.effectiveMode
            }
          );
          transition(snapshot, "awaiting_mode_approval");
          emit("decision.requested", "system", { decision });
          emit("run.transitioned", "system", {
            from: classifiedState,
            to: snapshot.state
          });
        } else if (
          previous === "plan_review" ||
          (snapshot.mode === "light" &&
            (previous === "classified" || previous === "planning"))
        ) {
          const independentlyReviewed = previous === "plan_review";
          const decision = this.createDecision(
            snapshot,
            "plan",
            independentlyReviewed
              ? "方案已通过独立审议，是否进入代码实施？"
              : "轻量方案已完成，是否进入代码实施？",
            [
              {
                id: "approve",
                label: "批准实施",
                description: "按当前方案派工并进入执行阶段。",
                recommended: true
              },
              {
                id: "adjust",
                label: "调整方案",
                description: "保留主要方向并补充修改意见。",
                recommended: false
              },
              {
                id: "replan",
                label: "重新规划",
                description: "放弃当前方案并生成新方案。",
                recommended: false
              }
            ],
            {
              planArtifactId: artifact.id,
              independentlyReviewed
            }
          );
          emit("decision.requested", "system", { decision });
        } else if (snapshot.state === "awaiting_verification_decision") {
          const decision = this.createDecision(
            snapshot,
            "verification",
            "验证证据不足，如何继续？",
            [
              {
                id: "provide-evidence",
                label: "补充验证证据",
                description: "重新运行或补充可执行的验证命令。",
                recommended: true
              },
              {
                id: "retry",
                label: "重新验证",
                description: "重新派遣独立验证者执行验证。",
                recommended: false
              },
              {
                id: "cancel",
                label: "取消运行",
                description: "保留现场并停止本次运行。",
                recommended: false
              }
            ],
            {
              verificationStatus: snapshot.verificationStatus,
              verificationResult:
                snapshot.verificationResults.at(-1) ?? null
            }
          );
          emit("decision.requested", "system", { decision });
        } else {
          if (
            snapshot.state === "result_review" &&
            snapshot.resultReviewCompleted &&
            snapshot.verificationStatus === "passed"
          ) {
            const reviewState = snapshot.state;
            transition(snapshot, "awaiting_merge_approval");
            emit("run.transitioned", "system", {
              from: reviewState,
              to: snapshot.state
            });
          }
        }
        if (snapshot.state === "awaiting_merge_approval") {
          const options: DecisionOption[] = snapshot.candidates
            .filter((candidate) =>
              ["verified", "selected"].includes(candidate.status)
            )
            .map((candidate, index) => ({
              id: `candidate:${candidate.id}`,
              label: `合并候选 ${candidate.id}`,
              description: `分支 ${candidate.branch}，验证产物 ${candidate.verificationArtifacts.length} 项。`,
              recommended: index === 0
            }));
          if (options.length === 0) {
            options.push({
              id: "integrate",
              label: "合并当前实现",
              description: "使用当前工作区中的已审查实现继续交付。",
              recommended: true
            });
          }
          options.push(
            {
              id: "keep-branches",
              label: "仅保留候选分支",
              description: "不合并到当前分支，保留现场供人工处理。",
              recommended: false
            },
            {
              id: "reject",
              label: "拒绝交付",
              description: "返回执行阶段继续修改。",
              recommended: false
            }
          );
          const decision = this.createDecision(
            snapshot,
            "merge",
            "请选择最终交付方式",
            options,
            {
              candidates: snapshot.candidates,
              resultArtifactId: artifact.id
            }
          );
          emit("decision.requested", "system", { decision });
        }
      }
      return emitted;
    });
  }

  async approve(id: string, gate: ApprovalGate, actor = "user"): Promise<RunSnapshot> {
    if (gate !== "plan" && gate !== "merge") {
      throw new Error(`Legacy approve only supports plan or merge, not ${gate}`);
    }
    const snapshot = await this.store.load(id);
    this.ensureCoordinationFields(snapshot);
    const decision = snapshot.decisions.find(
      (item) => item.kind === gate && item.status === "pending"
    );
    if (!decision) throw new Error(`No pending ${gate} decision`);
    const choice =
      gate === "plan"
        ? "approve"
        : decision.options.find((option) => option.id.startsWith("candidate:"))
            ?.id ??
          (decision.options.some((option) => option.id === "integrate")
            ? "integrate"
            : "keep-branches");
    await this.decide(id, decision.id, choice, actor);
    return this.store.update(id, (_updated, events) =>
      nextEvent(events, id, "gate.approved", actor, { gate, choice })
    );
  }

  async reject(
    id: string,
    gate: RejectionGate,
    reason: string,
    actor = "governance.judge"
  ): Promise<RunSnapshot> {
    if (!reason.trim()) throw new Error("Rejection reason is required");
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      const allowed =
        gate === "plan"
          ? ["plan_review", "awaiting_plan_approval"]
          : ["result_review", "awaiting_merge_approval"];
      if (!allowed.includes(snapshot.state)) {
        throw new Error(`Cannot reject ${gate} while run is ${snapshot.state}`);
      }
      const pending = this.pendingDecision(snapshot);
      if (pending) {
        pending.status = "resolved";
        pending.selectedOption = "legacy-reject";
        pending.resolvedAt = new Date().toISOString();
      }
      let conflictDecision: DecisionRequest | undefined;
      if (gate === "plan") {
        snapshot.planReworks += 1;
        if (snapshot.planReworks > snapshot.budget.maxPlanReworks) {
          conflictDecision = this.createDecision(
            snapshot,
            "conflict",
            "方案返工次数已超限，如何继续？",
            [
              {
                id: "retry",
                label: "再尝试一次",
                description: "返回规划阶段并允许额外一次人工监督的重试。",
                recommended: true
              },
              {
                id: "cancel",
                label: "取消运行",
                description: "保留当前产物并终止运行。",
                recommended: false
              }
            ],
            { reason: "plan-rework-limit", returnState: "planning" }
          );
          transition(snapshot, "awaiting_conflict_decision");
        } else {
          snapshot.reworkTarget = "planning";
          transition(snapshot, "rework");
        }
      } else {
        snapshot.resultReworks += 1;
        if (snapshot.resultReworks > snapshot.budget.maxResultReworks) {
          conflictDecision = this.createDecision(
            snapshot,
            "conflict",
            "成果修复次数已超限，如何继续？",
            [
              {
                id: "retry",
                label: "继续修复",
                description: "返回执行阶段并重新派遣专家。",
                recommended: true
              },
              {
                id: "keep-worktrees",
                label: "保留候选",
                description: "停止自动流程并保留工作区供人工处理。",
                recommended: false
              },
              {
                id: "cancel",
                label: "取消运行",
                description: "保留现场并终止运行。",
                recommended: false
              }
            ],
            { reason: "result-rework-limit", returnState: "executing" }
          );
          transition(snapshot, "awaiting_conflict_decision");
        } else {
          snapshot.reworkTarget = "executing";
          transition(snapshot, "rework");
        }
      }
      const rejected = nextEvent(events, id, "gate.rejected", actor, {
        gate,
        reason,
        state: snapshot.state
      });
      if (!conflictDecision) return rejected;
      return [
        rejected,
        nextEvent(
          [...events, rejected],
          id,
          "decision.requested",
          "system",
          { decision: conflictDecision }
        )
      ];
    });
  }

  async resume(id: string, actor = "user"): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      if (!["rework", "blocked", "failed"].includes(snapshot.state)) {
        throw new Error(`Cannot resume run from ${snapshot.state}`);
      }
      const target = snapshot.reworkTarget ?? this.recoveryTarget(snapshot);
      const previous = snapshot.state;
      transition(snapshot, target);
      delete snapshot.failure;
      const resumed = nextEvent(events, id, "run.resumed", actor, { target });
      return [
        resumed,
        nextEvent([...events, resumed], id, "run.transitioned", "system", {
          from: previous,
          to: target
        })
      ];
    });
  }

  async cancel(id: string, actor = "user"): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      if (snapshot.readOnlyRecovery) {
        throw new Error(
          `Run ${snapshot.id} is in read-only recovery: ${snapshot.readOnlyRecovery.reason}`
        );
      }
      if (["completed", "cancelled"].includes(snapshot.state)) {
        throw new Error(`Run ${snapshot.id} is terminal: ${snapshot.state}`);
      }
      const previous = snapshot.state;
      transition(snapshot, "cancelled");
      const cancelled = nextEvent(events, id, "run.cancelled", actor, {});
      return [
        cancelled,
        nextEvent([...events, cancelled], id, "run.transitioned", "system", {
          from: previous,
          to: "cancelled"
        })
      ];
    });
  }

  async registerCandidate(
    id: string,
    candidate: Omit<WorkspaceCandidate, "status" | "verificationArtifacts">,
    actor = "main"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      if (snapshot.mode !== "full") {
        throw new Error("Workspace candidates require full mode");
      }
      if (snapshot.state !== "executing") {
        throw new Error(
          `Workspace candidates can only be created while executing, not ${snapshot.state}`
        );
      }
      if (candidate.baselineCommit !== snapshot.baselineCommit) {
        throw new Error("Candidate baseline does not match the run baseline");
      }
      if (snapshot.candidates.some((item) => item.id === candidate.id)) {
        throw new Error(`Candidate already exists: ${candidate.id}`);
      }
      if (
        snapshot.candidates.length >= snapshot.budget.maxCompetingImplementations
      ) {
        throw new Error(
          `Candidate budget exceeded (${snapshot.budget.maxCompetingImplementations})`
        );
      }
      const record: WorkspaceCandidate = {
        ...candidate,
        status: "active",
        verificationArtifacts: []
      };
      snapshot.candidates.push(record);
      return nextEvent(events, id, "candidate.created", actor, {
        candidate: record
      });
    });
  }

  async verifyCandidate(
    id: string,
    candidateId: string,
    artifactPath: string,
    actor = "expert.tester"
  ): Promise<RunSnapshot> {
    const resolvedArtifact = resolve(artifactPath);
    await sha256File(resolvedArtifact);
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      if (!["executing", "verification", "result_review"].includes(snapshot.state)) {
        throw new Error(
          `Candidates cannot be verified while run is ${snapshot.state}`
        );
      }
      const candidate = snapshot.candidates.find(
        (item) => item.id === candidateId
      );
      if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
      if (!candidate.verificationArtifacts.includes(resolvedArtifact)) {
        candidate.verificationArtifacts.push(resolvedArtifact);
      }
      candidate.status = "verified";
      return nextEvent(events, id, "candidate.verified", actor, {
        candidateId,
        artifactPath: resolvedArtifact
      });
    });
  }

  async markCandidateConflict(
    id: string,
    candidateId: string,
    message: string,
    actor = "system"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      if (snapshot.state !== "integrating") {
        throw new Error(`Candidate integration requires integrating state`);
      }
      const candidate = snapshot.candidates.find(
        (item) => item.id === candidateId
      );
      if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
      candidate.status = "conflicted";
      const decision = this.createDecision(
        snapshot,
        "conflict",
        `候选 ${candidateId} 合并冲突，如何处理？`,
        [
          {
            id: "retry",
            label: "人工处理后重试",
            description: "保留冲突现场，处理完成后重新尝试集成。",
            recommended: true
          },
          {
            id: "keep-worktrees",
            label: "保留候选分支",
            description: "停止自动集成并保留全部候选。",
            recommended: false
          },
          {
            id: "cancel",
            label: "取消运行",
            description: "保留现场并终止运行。",
            recommended: false
          }
        ],
        {
          reason: "merge-conflict",
          candidateId,
          message,
          returnState: "integrating"
        }
      );
      const previous = snapshot.state;
      transition(snapshot, "awaiting_conflict_decision");
      const conflict = nextEvent(events, id, "candidate.conflicted", actor, {
        candidateId,
        message
      });
      const requested = nextEvent(
        [...events, conflict],
        id,
        "decision.requested",
        "system",
        { decision }
      );
      return [
        conflict,
        requested,
        nextEvent(
          [...events, conflict, requested],
          id,
          "run.transitioned",
          "system",
          { from: previous, to: snapshot.state }
        )
      ];
    });
  }

  async markCandidateIntegrated(
    id: string,
    candidateId: string,
    commit: string,
    actor = "governance.publisher"
  ): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      this.ensureCoordinationFields(snapshot);
      const candidate = snapshot.candidates.find(
        (item) => item.id === candidateId
      );
      if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
      this.selectCandidateRecord(snapshot, candidateId);
      return nextEvent(events, id, "candidate.integrated", actor, {
        candidateId,
        commit
      });
    });
  }

  private createDecision(
    snapshot: RunSnapshot,
    kind: DecisionKind,
    question: string,
    options: DecisionOption[],
    context: Record<string, unknown> = {}
  ): DecisionRequest {
    if (this.pendingDecision(snapshot)) {
      throw new Error("A decision is already pending");
    }
    const decision: DecisionRequest = {
      id: `decision-${snapshot.decisions.length + 1}`,
      kind,
      question,
      options,
      context,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    snapshot.decisions.push(decision);
    return decision;
  }

  private selectCandidateRecord(
    snapshot: RunSnapshot,
    candidateId: string
  ): void {
    const selected = snapshot.candidates.find(
      (candidate) => candidate.id === candidateId
    );
    if (!selected) throw new Error(`Candidate not found: ${candidateId}`);
    if (!["verified", "selected"].includes(selected.status)) {
      throw new Error(`Candidate ${candidateId} is not verified`);
    }
    snapshot.selectedCandidateId = candidateId;
    for (const candidate of snapshot.candidates) {
      candidate.status =
        candidate.id === candidateId ? "selected" : "rejected";
    }
  }

  private pendingDecision(snapshot: RunSnapshot): DecisionRequest | undefined {
    return snapshot.decisions.find((decision) => decision.status === "pending");
  }

  private assertRuntimeCapabilities(snapshot: RunSnapshot): void {
    const report = snapshot.runtimeCapabilities;
    if (!report) {
      throw new Error(
        "Runtime capabilities must be registered before claiming a child agent"
      );
    }
    if (report.capabilities.subagents !== "available") {
      throw new Error("Codex subagents are not available in this runtime");
    }
    if (
      snapshot.mode === "full" &&
      report.capabilities.parallelAgents !== "available"
    ) {
      throw new Error(
        "Full mode requires parallel agent capability in this runtime"
      );
    }
  }

  private operationPermission(
    snapshot: RunSnapshot,
    type: OperationType
  ): "deny" | "approval" {
    const permissions = snapshot.templatePermissions;
    switch (type) {
      case "network":
        return permissions.network;
      case "dependency-install":
        return permissions.dependencyInstall;
      case "destructive":
      case "migration":
        return permissions.destructive;
      case "publish":
      case "external-write":
        return permissions.externalWrite;
      case "sensitive-read":
        return permissions.sensitiveRead;
    }
  }

  private applyDecision(
    snapshot: RunSnapshot,
    decision: DecisionRequest,
    choiceId: string
  ): void {
    switch (decision.kind) {
      case "mode":
        if (choiceId !== "light" && choiceId !== "full") {
          throw new Error(`Unsupported mode choice: ${choiceId}`);
        }
        snapshot.mode = choiceId;
        snapshot.budget = snapshot.modeBudgets[choiceId];
        snapshot.approvals.mode = new Date().toISOString();
        transition(snapshot, "classified");
        return;
      case "escalation":
        if (choiceId === "cancel") {
          transition(snapshot, "cancelled");
          return;
        }
        if (choiceId !== "upgrade-full") {
          throw new Error(`Unsupported escalation choice: ${choiceId}`);
        }
        snapshot.mode = "full";
        snapshot.budget = snapshot.modeBudgets.full;
        snapshot.approvals.mode = new Date().toISOString();
        snapshot.reworkTarget = "planning";
        transition(snapshot, "planning");
        return;
      case "verification":
        if (choiceId === "cancel") {
          transition(snapshot, "cancelled");
          return;
        }
        if (choiceId !== "retry" && choiceId !== "provide-evidence") {
          throw new Error(`Unsupported verification choice: ${choiceId}`);
        }
        snapshot.verificationAttemptStatus = "not_started";
        snapshot.verificationStatus = "unverified";
        snapshot.verificationCompleted = false;
        snapshot.resultReviewCompleted = false;
        transition(snapshot, "verification");
        return;
      case "plan":
        if (choiceId === "approve") {
          snapshot.approvals.plan = new Date().toISOString();
          transition(snapshot, "dispatching");
          return;
        }
        snapshot.reworkTarget = "planning";
        snapshot.planReworks += 1;
        transition(snapshot, "rework");
        return;
      case "risk": {
        const returnState = snapshot.pendingOperation?.returnState ?? "executing";
        if (choiceId === "cancel") {
          transition(snapshot, "cancelled");
        } else {
          if (choiceId === "approve-once") {
            snapshot.approvals.risk = new Date().toISOString();
          }
          transition(snapshot, returnState);
        }
        delete snapshot.pendingOperation;
        return;
      }
      case "conflict": {
        if (choiceId === "cancel") {
          transition(snapshot, "cancelled");
          return;
        }
        if (choiceId === "keep-worktrees") {
          transition(snapshot, "completed");
          return;
        }
        const returnState = decision.context.returnState;
        const recoverableStates: RunState[] = [
          "created",
          "classified",
          "planning",
          "plan_review",
          "dispatching",
          "executing",
          "verification",
          "result_review",
          "integrating"
        ];
        transition(
          snapshot,
          recoverableStates.includes(returnState as RunState)
            ? (returnState as RunState)
            : "executing"
        );
        return;
      }
      case "merge":
        if (choiceId === "keep-branches") {
          snapshot.approvals.merge = new Date().toISOString();
          transition(snapshot, "completed");
          return;
        }
        if (choiceId === "reject") {
          snapshot.reworkTarget = "executing";
          snapshot.resultReworks += 1;
          transition(snapshot, "rework");
          return;
        }
        if (choiceId.startsWith("candidate:")) {
          const candidateId = choiceId.slice("candidate:".length);
          this.selectCandidateRecord(snapshot, candidateId);
        }
        snapshot.approvals.merge = new Date().toISOString();
        transition(snapshot, "integrating");
        return;
    }
  }

  private assertRoleAllowed(snapshot: RunSnapshot, roleId: string): void {
    this.ensureCoordinationFields(snapshot);
    const expected: Partial<Record<RunState, string[]>> = {
      created: ["governance.router"],
      classified: ["governance.planner"],
      planning: ["governance.planner"],
      plan_review: ["governance.judge"],
      dispatching: ["governance.dispatcher"],
      executing: snapshot.allowedSpecialists.filter(
        (candidate) => candidate !== "expert.tester"
      ),
      verification:
        ["expert.tester"],
      result_review: ["governance.judge"],
      integrating: ["governance.publisher"]
    };
    const allowed = expected[snapshot.state];
    if (
      !allowed?.includes(roleId) ||
      (roleId.startsWith("governance.") &&
        !snapshot.allowedGovernance.includes(roleId)) ||
      (roleId.startsWith("expert.") &&
        !snapshot.allowedSpecialists.includes(roleId))
    ) {
      throw new Error(`Role ${roleId} cannot submit while run is ${snapshot.state}`);
    }
  }

  private canRootManage(snapshot: RunSnapshot, roleId: string): boolean {
    return (
      ["governance.router", "governance.dispatcher", "governance.publisher"].includes(
        roleId
      ) ||
      (snapshot.mode === "light" && roleId === "governance.planner")
    );
  }

  private ensureCoordinationFields(snapshot: RunSnapshot): void {
    snapshot.modelPolicy ??= DEFAULT_MODEL_POLICY;
    snapshot.templatePermissions ??= {
      network: "approval",
      dependencyInstall: "approval",
      destructive: "approval",
      externalWrite: "approval",
      sensitiveRead: "deny"
    };
    snapshot.allowedGovernance ??= [
      "governance.router",
      "governance.planner",
      "governance.judge",
      "governance.dispatcher",
      "governance.publisher"
    ];
    snapshot.allowedSpecialists ??= [
      "expert.builder",
      "expert.tester",
      "expert.debugger",
      "expert.security",
      "expert.architect",
      "expert.documenter",
      "expert.data",
      "expert.operations",
      "expert.migrator"
    ];
    snapshot.activeAgents ??= [];
    snapshot.agentInstances ??= [];
    snapshot.decisions ??= [];
    snapshot.candidates ??= [];
    snapshot.verificationAttemptStatus ??= "not_started";
    snapshot.verificationStatus ??= "unverified";
    snapshot.verificationResults ??= [];
    snapshot.requiredVerification ??= [];
    snapshot.activeElapsedMs ??= 0;
    snapshot.budgetExtensions ??= [];
    if (
      !snapshot.activeSince &&
      !snapshot.pausedAt &&
      !isRunClockPaused(snapshot.state) &&
      !["completed", "cancelled"].includes(snapshot.state)
    ) {
      snapshot.activeSince = snapshot.updatedAt ?? snapshot.startedAt;
    }
    snapshot.budget.leaseTimeoutMinutes ??=
      snapshot.mode === "full" ? 10 : 5;
  }

  private stateAfterSubmission(
    snapshot: RunSnapshot,
    roleId: string,
    final: boolean
  ): RunState | undefined {
    switch (snapshot.state) {
      case "created":
        return "classified";
      case "classified":
        return snapshot.mode === "light"
          ? "awaiting_plan_approval"
          : "plan_review";
      case "planning":
        return snapshot.mode === "light"
          ? "awaiting_plan_approval"
          : "plan_review";
      case "plan_review":
        return "awaiting_plan_approval";
      case "dispatching":
        return "executing";
      case "executing":
        if (final) {
          snapshot.verificationCompleted = false;
          snapshot.verificationAttemptStatus = "not_started";
          snapshot.verificationStatus = "unverified";
          snapshot.resultReviewCompleted = false;
          return "verification";
        }
        return undefined;
      case "verification":
        if (roleId === "expert.tester") {
          snapshot.verificationCompleted = true;
          if (snapshot.mode === "light") {
            snapshot.resultReviewCompleted = true;
          }
        }
        if (!snapshot.verificationCompleted) {
          return undefined;
        }
        if (snapshot.verificationStatus === "failed") {
          snapshot.resultReworks += 1;
          if (snapshot.resultReworks > snapshot.budget.maxResultReworks) {
            return "blocked";
          }
          snapshot.reworkTarget = "executing";
          return "rework";
        }
        if (snapshot.verificationStatus === "unverified") {
          return "awaiting_verification_decision";
        }
        return "result_review";
      case "result_review":
        return "awaiting_merge_approval";
      case "integrating":
        return "completed";
      default:
        throw new Error(`Submissions are not accepted while run is ${snapshot.state}`);
    }
  }

  private recoveryTarget(snapshot: RunSnapshot): "planning" | "executing" | "verification" {
    if (
      ["created", "classified", "planning", "plan_review", "awaiting_plan_approval"].includes(
        snapshot.previousState ?? "created"
      )
    ) {
      return "planning";
    }
    if (snapshot.previousState === "verification") return "verification";
    return "executing";
  }
}

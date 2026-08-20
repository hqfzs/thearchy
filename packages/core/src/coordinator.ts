import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { assessRisk } from "./risk.js";
import { resolveBudget } from "./budget.js";
import { inspectGitBaseline } from "./git.js";
import { ROLE_BY_ID } from "./roles.js";
import { assertRunActive, assertTransition, nextAction } from "./state-machine.js";
import { nextEvent, RunStore } from "./store.js";
import { sha256File } from "./security.js";
import type {
  ApprovalGate,
  ArtifactRecord,
  NextAction,
  RejectionGate,
  RunBudget,
  RunMode,
  RunSnapshot,
  RunState,
  TeamTemplate
} from "./types.js";

function runId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

function transition(snapshot: RunSnapshot, state: RunState): void {
  assertTransition(snapshot.state, state);
  snapshot.previousState = snapshot.state;
  snapshot.state = state;
  if (state === "completed") {
    snapshot.completedAt = new Date().toISOString();
  }
}

export interface StartRunInput {
  task: string;
  template: TeamTemplate;
  requestedMode: RunMode;
  cwd: string;
  budgetOverrides?: Partial<RunBudget>;
}

export interface SubmitArtifactInput {
  runId: string;
  roleId: string;
  instanceId: string;
  artifactPath: string;
  final?: boolean;
  actor?: string;
}

export class Coordinator {
  constructor(readonly store: RunStore) {}

  async start(input: StartRunInput): Promise<RunSnapshot> {
    const id = runId();
    const risk = assessRisk(input.task, input.requestedMode);
    const baseline = inspectGitBaseline(input.cwd);
    const profile = input.template.spec.profiles[risk.effectiveMode];
    const budget = resolveBudget(
      risk.effectiveMode,
      profile,
      input.budgetOverrides
    );
    const now = new Date().toISOString();
    const snapshot: RunSnapshot = {
      id,
      schemaVersion: 1,
      task: input.task,
      templateId: input.template.metadata.id,
      requestedMode: input.requestedMode,
      mode: risk.effectiveMode,
      risk,
      state: "created",
      planReworks: 0,
      resultReworks: 0,
      allowedGovernance: [...input.template.spec.governance],
      allowedSpecialists: [...input.template.spec.specialists],
      participants: [],
      activeAgents: [],
      agentInstances: [],
      artifacts: [],
      approvals: {},
      dirtyWorkingTree: baseline.dirty,
      budget,
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

  async next(id: string): Promise<NextAction> {
    const snapshot = await this.store.load(id);
    assertRunActive(snapshot);
    return nextAction(snapshot);
  }

  async claim(
    id: string,
    roleId: string,
    instanceId: string,
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
      if (!existing && !role.governance) {
        const expertCount = snapshot.agentInstances.filter(
          (instance) => ROLE_BY_ID.get(instance.roleId)?.governance === false
        ).length;
        if (expertCount >= snapshot.budget.maxAgents) {
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
      snapshot.activeAgents.push({ instanceId, roleId, claimedAt });
      if (!existing) snapshot.agentInstances.push({ instanceId, roleId });
      if (!snapshot.participants.includes(roleId)) snapshot.participants.push(roleId);
      return nextEvent(events, id, "agent.claimed", actor, {
        instanceId,
        roleId,
        activeAgents: snapshot.activeAgents.length
      });
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

  async submit(input: SubmitArtifactInput): Promise<RunSnapshot> {
    if (!ROLE_BY_ID.has(input.roleId)) {
      throw new Error(`Unknown role: ${input.roleId}`);
    }
    const artifactPath = resolve(input.artifactPath);
    const sha256 = await sha256File(artifactPath);

    return this.store.update(input.runId, (snapshot, events) => {
      assertRunActive(snapshot);
      this.ensureCoordinationFields(snapshot);
      this.assertRoleAllowed(snapshot, input.roleId);
      const lease = snapshot.activeAgents.find(
        (item) =>
          item.instanceId === input.instanceId && item.roleId === input.roleId
      );
      if (!lease) {
        throw new Error(
          `Agent ${input.instanceId} must claim role ${input.roleId} before submitting`
        );
      }
      const remainingAgents = snapshot.activeAgents.filter(
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
        path: artifactPath,
        sha256,
        createdAt: new Date().toISOString(),
        final: input.final ?? false
      };
      snapshot.artifacts.push(artifact);
      snapshot.activeAgents = remainingAgents;

      const emitted = [
        nextEvent(
          events,
          snapshot.id,
          "artifact.submitted",
          input.actor ?? input.instanceId,
          { artifact, instanceId: input.instanceId }
        )
      ];
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
      const previous = snapshot.state;
      const advance = this.stateAfterSubmission(snapshot, input.roleId, input.final ?? false);
      if (advance) {
        transition(snapshot, advance);
        emitted.push(
          nextEvent(
            [...events, ...emitted],
            snapshot.id,
            "run.transitioned",
            "system",
            { from: previous, to: snapshot.state }
          )
        );
      }
      return emitted;
    });
  }

  async approve(id: string, gate: ApprovalGate, actor = "user"): Promise<RunSnapshot> {
    return this.store.update(id, (snapshot, events) => {
      assertRunActive(snapshot);
      const expected =
        gate === "plan" ? "awaiting_plan_approval" : "awaiting_merge_approval";
      if (snapshot.state !== expected) {
        throw new Error(`Cannot approve ${gate} while run is ${snapshot.state}`);
      }
      const target = gate === "plan" ? "dispatching" : "integrating";
      const previous = snapshot.state;
      snapshot.approvals[gate] = new Date().toISOString();
      transition(snapshot, target);
      const approved = nextEvent(events, id, "gate.approved", actor, { gate });
      return [
        approved,
        nextEvent([...events, approved], id, "run.transitioned", "system", {
          from: previous,
          to: target
        })
      ];
    });
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
      const allowed =
        gate === "plan"
          ? ["plan_review", "awaiting_plan_approval"]
          : ["result_review", "awaiting_merge_approval"];
      if (!allowed.includes(snapshot.state)) {
        throw new Error(`Cannot reject ${gate} while run is ${snapshot.state}`);
      }
      if (gate === "plan") {
        snapshot.planReworks += 1;
        if (snapshot.planReworks > snapshot.budget.maxPlanReworks) {
          transition(snapshot, "blocked");
        } else {
          snapshot.reworkTarget = "planning";
          transition(snapshot, "rework");
        }
      } else {
        snapshot.resultReworks += 1;
        if (snapshot.resultReworks > snapshot.budget.maxResultReworks) {
          transition(snapshot, "blocked");
        } else {
          snapshot.reworkTarget = "executing";
          transition(snapshot, "rework");
        }
      }
      return nextEvent(events, id, "gate.rejected", actor, {
        gate,
        reason,
        state: snapshot.state
      });
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
      assertRunActive(snapshot);
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
      verification: ["expert.tester"],
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

  private ensureCoordinationFields(snapshot: RunSnapshot): void {
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
        return "planning";
      case "planning":
        return "plan_review";
      case "plan_review":
        return "awaiting_plan_approval";
      case "dispatching":
        return "executing";
      case "executing":
        return final ? "verification" : undefined;
      case "verification":
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

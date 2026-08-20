import type { NextAction, RunSnapshot, RunState } from "./types.js";

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: [
    "classified",
    "awaiting_mode_approval",
    "awaiting_conflict_decision",
    "cancelled",
    "failed"
  ],
  classified: [
    "awaiting_mode_approval",
    "planning",
    "awaiting_conflict_decision",
    "cancelled",
    "failed"
  ],
  awaiting_mode_approval: ["classified", "cancelled", "failed"],
  planning: [
    "plan_review",
    "awaiting_conflict_decision",
    "cancelled",
    "failed"
  ],
  plan_review: [
    "awaiting_plan_approval",
    "awaiting_conflict_decision",
    "rework",
    "blocked",
    "cancelled",
    "failed"
  ],
  awaiting_plan_approval: ["dispatching", "rework", "cancelled", "failed"],
  dispatching: [
    "executing",
    "awaiting_conflict_decision",
    "blocked",
    "cancelled",
    "failed"
  ],
  executing: [
    "awaiting_risk_approval",
    "verification",
    "blocked",
    "awaiting_conflict_decision",
    "cancelled",
    "failed"
  ],
  awaiting_risk_approval: [
    "executing",
    "integrating",
    "verification",
    "blocked",
    "cancelled",
    "failed"
  ],
  verification: [
    "awaiting_risk_approval",
    "result_review",
    "awaiting_conflict_decision",
    "blocked",
    "cancelled",
    "failed"
  ],
  result_review: [
    "awaiting_merge_approval",
    "awaiting_conflict_decision",
    "rework",
    "blocked",
    "cancelled",
    "failed"
  ],
  awaiting_conflict_decision: [
    "created",
    "classified",
    "planning",
    "plan_review",
    "dispatching",
    "executing",
    "verification",
    "result_review",
    "integrating",
    "completed",
    "blocked",
    "cancelled",
    "failed"
  ],
  awaiting_merge_approval: ["integrating", "rework", "cancelled", "failed"],
  integrating: [
    "awaiting_risk_approval",
    "awaiting_conflict_decision",
    "completed",
    "blocked",
    "cancelled",
    "failed"
  ],
  completed: [],
  rework: ["planning", "executing", "cancelled", "failed"],
  blocked: ["planning", "executing", "verification", "cancelled", "failed"],
  cancelled: [],
  failed: ["planning", "executing", "verification", "cancelled"]
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

export function assertRunActive(snapshot: RunSnapshot): void {
  if (snapshot.readOnlyRecovery) {
    throw new Error(
      `Run ${snapshot.id} is in read-only recovery: ${snapshot.readOnlyRecovery.reason}`
    );
  }
  if (["completed", "cancelled"].includes(snapshot.state)) {
    throw new Error(`Run ${snapshot.id} is terminal: ${snapshot.state}`);
  }
  const elapsedMs = Date.now() - Date.parse(snapshot.startedAt);
  const limitMs = snapshot.budget.timeoutMinutes * 60_000;
  if (limitMs > 0 && elapsedMs > limitMs) {
    throw new Error(
      `Run ${snapshot.id} exceeded its ${snapshot.budget.timeoutMinutes} minute budget`
    );
  }
}

export function nextAction(snapshot: RunSnapshot): NextAction {
  const interaction = snapshot.decisions.find(
    (decision) => decision.status === "pending"
  );
  const withPolicy = (action: NextAction): NextAction => ({
    ...action,
    ...(action.roleId ? { modelPolicy: snapshot.modelPolicy } : {}),
    ...(interaction ? { interaction } : {})
  });
  const actions: Record<RunState, NextAction> = {
    created: {
      state: "created",
      roleId: "governance.router",
      action: "classify",
      instructions: "Classify risk, scope, required specialists, and effective mode.",
      requiresUserApproval: false
    },
    classified: {
      state: "classified",
      roleId: "governance.planner",
      action: "plan",
      instructions:
        snapshot.mode === "full"
          ? "Produce two or three independent implementation plans."
          : "Produce one concise implementation plan.",
      requiresUserApproval: false
    },
    awaiting_mode_approval: {
      state: "awaiting_mode_approval",
      action: "choose-mode",
      instructions:
        "Invoke the inquiry component and resolve the pending light/full mode decision.",
      requiresUserApproval: true
    },
    planning: {
      state: "planning",
      roleId: "governance.planner",
      action: "finish-plan",
      instructions: "Submit the final planning artifact.",
      requiresUserApproval: false
    },
    plan_review: {
      state: "plan_review",
      roleId: "governance.judge",
      action: "review-plan",
      instructions:
        "Independently review the plan. Submit a passing verdict artifact or reject the plan with reasons.",
      requiresUserApproval: false
    },
    awaiting_plan_approval: {
      state: "awaiting_plan_approval",
      action: "approve-plan",
      instructions: "A user must approve the reviewed plan before execution.",
      requiresUserApproval: true
    },
    dispatching: {
      state: "dispatching",
      roleId: "governance.dispatcher",
      action: "dispatch",
      instructions:
        "Create structured work orders with ownership, write scopes, verification, and dependencies.",
      requiresUserApproval: false
    },
    executing: {
      state: "executing",
      action: "execute",
      instructions:
        "Assigned expert agents execute their work orders. Mark the final expert artifact with --final.",
      requiresUserApproval: false
    },
    awaiting_risk_approval: {
      state: "awaiting_risk_approval",
      action: "approve-risk-operation",
      instructions:
        "Invoke the inquiry component. Do not execute the requested operation before a decision.",
      requiresUserApproval: true
    },
    verification: {
      state: "verification",
      roleId: "expert.tester",
      action: "verify",
      instructions:
        "Run detected quality checks and submit evidence. Missing tests must be reported as unverified.",
      requiresUserApproval: false
    },
    result_review: {
      state: "result_review",
      roleId: "governance.judge",
      action: "review-result",
      instructions:
        "Independently review the diff, test evidence, unresolved risks, and delivery readiness.",
      requiresUserApproval: false
    },
    awaiting_conflict_decision: {
      state: "awaiting_conflict_decision",
      action: "resolve-conflict",
      instructions:
        "Invoke the inquiry component to retry, replace the agent, keep worktrees, or cancel.",
      requiresUserApproval: true
    },
    awaiting_merge_approval: {
      state: "awaiting_merge_approval",
      action: "approve-merge",
      instructions: "A user must approve integration after reviewing evidence and diff.",
      requiresUserApproval: true
    },
    integrating: {
      state: "integrating",
      roleId: "governance.publisher",
      action: "publish",
      instructions:
        "Integrate the approved candidate or prepare the PR, then submit the final report.",
      requiresUserApproval: false
    },
    completed: {
      state: "completed",
      action: "done",
      instructions: "The run is complete.",
      requiresUserApproval: false
    },
    rework: {
      state: "rework",
      action: "resume-rework",
      instructions: `Resume the rejected ${snapshot.reworkTarget ?? "unknown"} stage.`,
      requiresUserApproval: false
    },
    blocked: {
      state: "blocked",
      action: "resolve-blocker",
      instructions: "Resolve the blocker, then resume the run.",
      requiresUserApproval: true
    },
    cancelled: {
      state: "cancelled",
      action: "cancelled",
      instructions: "The run was cancelled.",
      requiresUserApproval: false
    },
    failed: {
      state: "failed",
      action: "recover",
      instructions: "Inspect the failure and resume from the recorded recovery target.",
      requiresUserApproval: true
    }
  };
  return withPolicy(actions[snapshot.state]);
}

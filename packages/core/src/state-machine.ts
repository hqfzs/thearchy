import type { NextAction, RunSnapshot, RunState } from "./types.js";

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ["classified", "cancelled", "failed"],
  classified: ["planning", "cancelled", "failed"],
  planning: ["plan_review", "cancelled", "failed"],
  plan_review: ["awaiting_plan_approval", "rework", "blocked", "cancelled", "failed"],
  awaiting_plan_approval: ["dispatching", "rework", "cancelled", "failed"],
  dispatching: ["executing", "blocked", "cancelled", "failed"],
  executing: ["verification", "blocked", "cancelled", "failed"],
  verification: ["result_review", "blocked", "cancelled", "failed"],
  result_review: [
    "awaiting_merge_approval",
    "rework",
    "blocked",
    "cancelled",
    "failed"
  ],
  awaiting_merge_approval: ["integrating", "rework", "cancelled", "failed"],
  integrating: ["completed", "blocked", "cancelled", "failed"],
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
  return actions[snapshot.state];
}

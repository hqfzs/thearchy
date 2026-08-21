import type {
  EffectiveRunMode,
  RunBudget,
  TemplateProfile
} from "./types.js";

export const DEFAULT_BUDGETS: Record<EffectiveRunMode, RunBudget> = {
  light: {
    maxAgents: 3,
    maxConcurrency: 2,
    timeoutMinutes: 20,
    maxPlanReworks: 2,
    maxResultReworks: 1,
    maxCompetingImplementations: 1,
    leaseTimeoutMinutes: 5
  },
  full: {
    maxAgents: 4,
    maxConcurrency: 2,
    timeoutMinutes: 10,
    maxPlanReworks: 2,
    maxResultReworks: 1,
    maxCompetingImplementations: 1,
    leaseTimeoutMinutes: 5
  }
};

export function resolveBudget(
  mode: EffectiveRunMode,
  profile?: TemplateProfile,
  overrides: Partial<RunBudget> = {}
): RunBudget {
  const resolved = {
    ...DEFAULT_BUDGETS[mode],
    ...profile,
    ...overrides
  };

  for (const [key, value] of Object.entries(resolved)) {
    if (key === "strategy") continue;
    if (!Number.isFinite(value) || Number(value) < 0) {
      throw new Error(`Invalid budget value for ${key}: ${String(value)}`);
    }
  }

  if (resolved.maxConcurrency > resolved.maxAgents) {
    throw new Error("maxConcurrency cannot exceed maxAgents");
  }

  return {
    maxAgents: resolved.maxAgents,
    maxConcurrency: resolved.maxConcurrency,
    timeoutMinutes: resolved.timeoutMinutes,
    maxPlanReworks: resolved.maxPlanReworks,
    maxResultReworks: resolved.maxResultReworks,
    maxCompetingImplementations: resolved.maxCompetingImplementations,
    leaseTimeoutMinutes: resolved.leaseTimeoutMinutes
  };
}

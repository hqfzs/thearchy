export const RUN_STATES = [
  "created",
  "classified",
  "planning",
  "plan_review",
  "awaiting_plan_approval",
  "dispatching",
  "executing",
  "verification",
  "result_review",
  "awaiting_merge_approval",
  "integrating",
  "completed",
  "rework",
  "blocked",
  "cancelled",
  "failed"
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type RunMode = "auto" | "light" | "full";
export type EffectiveRunMode = Exclude<RunMode, "auto">;
export type CapabilityTier = "fast" | "reasoning" | "review";
export type VerificationCapability =
  | "test"
  | "lint"
  | "build"
  | "typecheck"
  | "security-scan";
export type ApprovalGate = "plan" | "merge";
export type RejectionGate = "plan" | "result";

export interface RoleDefinition {
  id: string;
  displayName: string;
  englishName: string;
  responsibility: string;
  tier: CapabilityTier;
  governance: boolean;
}

export interface RunBudget {
  maxAgents: number;
  maxConcurrency: number;
  timeoutMinutes: number;
  maxPlanReworks: number;
  maxResultReworks: number;
  maxCompetingImplementations: number;
}

export interface TemplateProfile extends Partial<RunBudget> {
  strategy: "single" | "competitive";
}

export interface TemplateMetadata {
  id: string;
  version: string;
  displayName: string;
  description?: string;
}

export interface TeamTemplate {
  apiVersion: "thearchy.dev/v1alpha1";
  kind: "TeamTemplate";
  metadata: TemplateMetadata;
  spec: {
    triggers: string[];
    profiles: {
      light: TemplateProfile;
      full: TemplateProfile;
    };
    governance: string[];
    specialists: string[];
    stages: string[];
    qualityGates: string[];
    capabilities: VerificationCapability[];
    permissions: {
      network: "deny" | "approval";
      dependencyInstall: "deny" | "approval";
      destructive: "deny" | "approval";
      externalWrite: "deny" | "approval";
    };
    verification: {
      required: VerificationCapability[];
      optional: VerificationCapability[];
    };
  };
}

export interface RiskAssessment {
  score: number;
  level: "low" | "medium" | "high";
  effectiveMode: EffectiveRunMode;
  reasons: string[];
}

export interface ArtifactRecord {
  id: string;
  roleId: string;
  path: string;
  sha256: string;
  createdAt: string;
  final: boolean;
}

export interface RunSnapshot {
  id: string;
  schemaVersion: 1;
  task: string;
  templateId: string;
  requestedMode: RunMode;
  mode: EffectiveRunMode;
  risk: RiskAssessment;
  state: RunState;
  previousState?: RunState;
  reworkTarget?: "planning" | "executing";
  planReworks: number;
  resultReworks: number;
  participants: string[];
  artifacts: ArtifactRecord[];
  approvals: Partial<Record<ApprovalGate, string>>;
  baselineCommit?: string;
  repositoryRoot?: string;
  dirtyWorkingTree: boolean;
  budget: RunBudget;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: string;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type:
    | "run.started"
    | "run.transitioned"
    | "artifact.submitted"
    | "gate.approved"
    | "gate.rejected"
    | "run.resumed"
    | "run.cancelled"
    | "run.failed";
  timestamp: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface NextAction {
  state: RunState;
  roleId?: string;
  action: string;
  instructions: string;
  requiresUserApproval: boolean;
}

export interface HostCapabilities {
  subagents: boolean;
  parallelAgents: boolean;
  customCommands: boolean;
  hooks: boolean;
  mcp: boolean;
  usageReporting: boolean;
}

export interface AdapterCompileResult {
  host: string;
  outputDirectory: string;
  files: string[];
  capabilities: HostCapabilities;
  nextSteps: string[];
}

export interface AdapterCompileOptions {
  runtimeCommand?: string;
  desktopInstall?: boolean;
  pluginAssetsDirectory?: string;
  version?: string;
}

export interface HostAdapter {
  readonly id: "codex" | "claude";
  readonly displayName: string;
  detect(): Promise<HostCapabilities>;
  compile(
    outputDirectory: string,
    templates: TeamTemplate[],
    roles: RoleDefinition[],
    options?: AdapterCompileOptions
  ): Promise<AdapterCompileResult>;
}

export interface DetectedCommand {
  capability: VerificationCapability;
  command: string;
  source: string;
  requiresApproval: boolean;
}

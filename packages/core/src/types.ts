export const RUN_STATES = [
  "created",
  "classified",
  "awaiting_mode_approval",
  "planning",
  "plan_review",
  "awaiting_plan_approval",
  "dispatching",
  "executing",
  "awaiting_risk_approval",
  "verification",
  "result_review",
  "awaiting_conflict_decision",
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
export type ApprovalGate = "mode" | "plan" | "risk" | "conflict" | "merge";
export type RejectionGate = "plan" | "result";
export type DecisionKind = "mode" | "plan" | "risk" | "conflict" | "merge";
export type OperationType =
  | "network"
  | "dependency-install"
  | "destructive"
  | "migration"
  | "publish"
  | "external-write"
  | "sensitive-read";
export type WorkspaceCandidateStatus =
  | "active"
  | "verified"
  | "selected"
  | "rejected"
  | "conflicted";

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
  leaseTimeoutMinutes: number;
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
      sensitiveRead: "deny" | "approval";
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

export interface AgentLease {
  instanceId: string;
  roleId: string;
  model: string;
  reasoningEffort: string;
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

export interface AgentInstanceRecord {
  instanceId: string;
  roleId: string;
  model: string;
  reasoningEffort: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface DecisionRequest {
  id: string;
  kind: DecisionKind;
  question: string;
  options: DecisionOption[];
  context: Record<string, unknown>;
  status: "pending" | "resolved";
  selectedOption?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ModelPolicy {
  model: "gpt-5.6-luna";
  reasoningEffort: "max";
  preserveMainModel: true;
}

export interface PendingOperation {
  id: string;
  type: OperationType;
  summary: string;
  requestedAt: string;
  returnState: RunState;
}

export interface WorkspaceCandidate {
  id: string;
  branch: string;
  path: string;
  baselineCommit: string;
  status: WorkspaceCandidateStatus;
  verificationArtifacts: string[];
}

export interface RunSnapshot {
  id: string;
  schemaVersion: 2;
  task: string;
  taskFingerprint: string;
  templateId: string;
  requestedMode: RunMode;
  mode: EffectiveRunMode;
  risk: RiskAssessment;
  state: RunState;
  previousState?: RunState;
  reworkTarget?: "planning" | "executing";
  planReworks: number;
  resultReworks: number;
  verificationCompleted: boolean;
  resultReviewCompleted: boolean;
  modelPolicy: ModelPolicy;
  templatePermissions: TeamTemplate["spec"]["permissions"];
  allowedGovernance: string[];
  allowedSpecialists: string[];
  participants: string[];
  activeAgents: AgentLease[];
  agentInstances: AgentInstanceRecord[];
  artifacts: ArtifactRecord[];
  decisions: DecisionRequest[];
  pendingOperation?: PendingOperation;
  candidates: WorkspaceCandidate[];
  selectedCandidateId?: string;
  approvals: Partial<Record<ApprovalGate, string>>;
  baselineCommit?: string;
  repositoryRoot?: string;
  dirtyWorkingTree: boolean;
  modeBudgets: Record<EffectiveRunMode, RunBudget>;
  budget: RunBudget;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: string;
  deadlineExceededAt?: string;
  readOnlyRecovery?: {
    reason: string;
    sourceSchemaVersion: unknown;
  };
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type:
    | "run.started"
    | "run.transitioned"
    | "artifact.submitted"
    | "agent.claimed"
    | "agent.released"
    | "agent.heartbeat"
    | "agent.expired"
    | "model.verified"
    | "decision.requested"
    | "decision.resolved"
    | "operation.requested"
    | "candidate.created"
    | "candidate.verified"
    | "candidate.selected"
    | "candidate.conflicted"
    | "candidate.integrated"
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
  parallelRoles?: string[];
  action: string;
  instructions: string;
  requiresUserApproval: boolean;
  interaction?: DecisionRequest;
  modelPolicy?: ModelPolicy;
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
  subagentModel?: string;
  subagentReasoningEffort?: string;
  preserveMainModel?: boolean;
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

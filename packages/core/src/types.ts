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
  "awaiting_escalation_decision",
  "verification",
  "awaiting_verification_decision",
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
export type ModeRouting =
  | "automatic-light"
  | "confirm"
  | "forced-full"
  | "explicit";
export type CapabilityTier = "fast" | "reasoning" | "review";
export type VerificationCapability =
  | "test"
  | "lint"
  | "build"
  | "typecheck"
  | "security-scan";
export type ApprovalGate = "mode" | "plan" | "risk" | "conflict" | "merge";
export type RejectionGate = "plan" | "result";
export type DecisionKind =
  | "mode"
  | "plan"
  | "risk"
  | "escalation"
  | "verification"
  | "conflict"
  | "merge";
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
export type CapabilityAvailability = "available" | "unavailable" | "unknown";
export type RiskSignalType =
  | "scope-expansion"
  | "sensitive-path"
  | "destructive-operation"
  | "migration"
  | "verification-gap";
export type VerificationStatus = "unverified" | "passed" | "failed";
export type VerificationAttemptStatus = "not_started" | "submitted";

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
  impactScore: number;
  complexityScore: number;
  uncertaintyScore: number;
  operationalScore: number;
  totalScore: number;
  /** @deprecated Use totalScore. Retained for v2/API compatibility. */
  score: number;
  level: "low" | "medium" | "high";
  effectiveMode: EffectiveRunMode;
  routing: ModeRouting;
  requiresModeApproval: boolean;
  reasons: string[];
  context: RiskContext;
}

export interface RiskContext {
  templateId?: string;
  gitStatus: "clean" | "dirty" | "unavailable";
  gitAvailable: boolean;
  dirtyWorkingTree: boolean;
  dirtyFileCount: number;
  sensitivePathsChanged: boolean;
  hasVerification: boolean;
  verificationCommands: Array<{
    capability: VerificationCapability;
    command: string;
  }>;
  projectKinds: string[];
  baselineCommit?: string;
}

export interface HostRuntimeReport {
  host: "codex";
  platform: "win32";
  checkedAt: string;
  source: "codex-runtime";
  capabilities: {
    subagents: CapabilityAvailability;
    parallelAgents: CapabilityAvailability;
    choicePrompt: CapabilityAvailability;
  };
  reportHash: string;
}

export interface VerificationCommandResult {
  capability: VerificationCapability;
  command: string;
  exitCode: number | null;
  durationMs: number;
  evidence?: string;
}

export interface VerificationFinding {
  severity: "low" | "medium" | "high";
  summary: string;
  evidence?: string;
}

export interface VerificationBoundaryCheck {
  category:
    | "type-confusion"
    | "nullability"
    | "range"
    | "compatibility"
    | "collection";
  input: string;
  expected: string;
  observed: string;
  passed: boolean;
  evidence?: string;
}

export interface VerificationResult {
  apiVersion: "thearchy.dev/verification/v1";
  status: VerificationStatus;
  attemptStatus: "submitted";
  attempt: number;
  createdAt: string;
  verifierInstanceId: string;
  implementerInstanceIds: string[];
  commands: VerificationCommandResult[];
  boundaryChecks: VerificationBoundaryCheck[];
  findings: VerificationFinding[];
  reviewedArtifactIds: string[];
  independent: true;
  unverifiedReason?:
    | "no-verification-command"
    | "command-not-executable"
    | "evidence-missing";
}

export interface ArtifactRecord {
  id: string;
  roleId: string;
  instanceId: string;
  path: string;
  sha256: string;
  createdAt: string;
  final: boolean;
  verification?: VerificationResult;
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
  schemaVersion: 3;
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
  verificationAttemptStatus: VerificationAttemptStatus;
  verificationStatus: VerificationStatus;
  verificationResults: VerificationResult[];
  resultReviewCompleted: boolean;
  modelPolicy: ModelPolicy;
  runtimeCapabilities?: HostRuntimeReport;
  runtimeCapabilitiesRegisteredAt?: string;
  requiredVerification: VerificationCapability[];
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
    | "host.capabilities.recorded"
    | "decision.requested"
    | "decision.resolved"
    | "operation.requested"
    | "risk.reassessed"
    | "mode.escalation.requested"
    | "verification.validated"
    | "store.recovered"
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
  requiredCapabilities?: Array<
    "subagents" | "parallelAgents" | "choicePrompt"
  >;
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

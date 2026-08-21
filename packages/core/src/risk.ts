import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitBaseline } from "./git.js";
import type {
  DetectedCommand,
  EffectiveRunMode,
  RiskAssessment,
  RiskContext,
  RiskSignalType,
  RunMode
} from "./types.js";

const IMPACT_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(delete|drop|truncate|destroy|reset)\b|删除|清空|销毁|重置/i, 4, "destructive change"],
  [/\b(migration|migrate|schema|database)\b|迁移|数据库|表结构/i, 3, "data migration"],
  [/\b(auth(?:entication)?|permissions?|security|secrets?|credentials?)\b|鉴权|权限|安全|密钥/i, 3, "security-sensitive"],
  [/\b(payment|billing|finance)\b|支付|计费|财务/i, 3, "financial impact"],
  [/\b(api|contract|breaking)\b|接口|破坏性变更/i, 2, "public contract change"]
];

const COMPLEXITY_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(concurrent|distributed|network)\b|并发|分布式|网络/i, 2, "distributed complexity"],
  [/\b(frontend.*backend|full[- ]?stack)\b|前后端|全栈/i, 2, "cross-layer change"],
  [/\b(multiple|many|across|entire|all)\b|多个|跨文件|全量|整个/i, 1, "large scope"],
  [/\b(refactor|rewrite|architecture)\b|重构|重写|架构/i, 1, "broad architectural change"]
];

const OPERATIONAL_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(deploy|release|production|infra)\b|部署|发布|生产|基础设施/i, 2, "operational impact"]
];

const SENSITIVE_PATH_PATTERN =
  /(^|[\\/])(auth|security|permissions?|migrations?|database|infra|deploy|payments?|billing)([\\/]|[._-]|$)/i;

export function inspectRiskContext(
  cwd: string,
  templateId: string,
  baseline: GitBaseline,
  verificationCommands: DetectedCommand[] = []
): RiskContext {
  const projectRoot = baseline.repositoryRoot ?? cwd;
  const projectKinds: string[] = [];
  let hasVerification = verificationCommands.length > 0;

  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    projectKinds.push("javascript-typescript");
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      hasVerification ||= Boolean(
        manifest.scripts &&
          ["test", "lint", "build", "typecheck"].some(
            (name) => typeof manifest.scripts?.[name] === "string"
          )
      );
    } catch {
      // Invalid metadata is surfaced during verification.
    }
  }

  if (
    ["pyproject.toml", "pytest.ini", "tox.ini"].some((name) =>
      existsSync(join(projectRoot, name))
    )
  ) {
    projectKinds.push("python");
    hasVerification ||= ["tests", "test", "pytest.ini", "tox.ini"].some(
      (name) => existsSync(join(projectRoot, name))
    );
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) {
    projectKinds.push("rust");
    hasVerification = true;
  }
  if (existsSync(join(projectRoot, "go.mod"))) {
    projectKinds.push("go");
    hasVerification = true;
  }

  return {
    templateId,
    gitStatus: baseline.available
      ? baseline.dirty
        ? "dirty"
        : "clean"
      : "unavailable",
    gitAvailable: baseline.available,
    dirtyWorkingTree: baseline.dirty,
    dirtyFileCount: baseline.dirtyFiles.length,
    sensitivePathsChanged: baseline.dirtyFiles.some((path) =>
      SENSITIVE_PATH_PATTERN.test(path)
    ),
    hasVerification,
    verificationCommands: verificationCommands.map(
      ({ capability, command }) => ({ capability, command })
    ),
    projectKinds,
    ...(baseline.commit ? { baselineCommit: baseline.commit } : {})
  };
}

function scorePatterns(
  task: string,
  patterns: Array<[RegExp, number, string]>
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const [pattern, weight, reason] of patterns) {
    if (pattern.test(task)) {
      score += weight;
      reasons.push(reason);
    }
  }
  return { score, reasons };
}

export function assessRisk(
  task: string,
  requestedMode: RunMode,
  context: RiskContext = {
    gitStatus: "clean",
    gitAvailable: true,
    dirtyWorkingTree: false,
    dirtyFileCount: 0,
    sensitivePathsChanged: false,
    hasVerification: true,
    verificationCommands: [],
    projectKinds: []
  }
): RiskAssessment {
  const normalizedTask = task.trim().replace(/\s+/g, " ").toLowerCase();
  const impact = scorePatterns(normalizedTask, IMPACT_PATTERNS);
  const complexity = scorePatterns(normalizedTask, COMPLEXITY_PATTERNS);
  const operational = scorePatterns(normalizedTask, OPERATIONAL_PATTERNS);
  let impactScore = Math.min(4, impact.score);
  let complexityScore = Math.min(3, complexity.score);
  let uncertaintyScore = 0;
  let operationalScore = Math.min(2, operational.score);
  const reasons = [
    ...impact.reasons,
    ...complexity.reasons,
    ...operational.reasons
  ];
  if (
    (/\b(remove|delete)\b|删除/i.test(normalizedTask) &&
      /\b(unused|import|comment)\b|未使用|导入|注释/i.test(normalizedTask))
  ) {
    impact.score = Math.max(0, impact.score - 4);
    const destructiveIndex = reasons.indexOf("destructive change");
    if (destructiveIndex >= 0) reasons.splice(destructiveIndex, 1);
  }
  impactScore = Math.min(4, impact.score);

  if (context.templateId === "refactor-migration") {
    complexityScore += 1;
    reasons.push("migration template");
  }
  if (!context.gitAvailable) {
    uncertaintyScore += 2;
    reasons.push("git unavailable");
  }
  if (context.dirtyWorkingTree) {
    uncertaintyScore += 1;
    reasons.push("dirty working tree");
  }
  if (context.dirtyFileCount >= 10) {
    uncertaintyScore += 2;
    reasons.push("many uncommitted files");
  } else if (context.dirtyFileCount >= 4) {
    uncertaintyScore += 1;
    reasons.push("several uncommitted files");
  }
  if (context.sensitivePathsChanged) {
    operationalScore += 2;
    reasons.push("sensitive paths already modified");
  }
  if (
    context.projectKinds.length > 0 &&
    !context.hasVerification &&
    !["code-review", "security-review"].includes(context.templateId ?? "")
  ) {
    uncertaintyScore += 2;
    reasons.push("no verification command detected");
  }
  if (context.projectKinds.length === 0) {
    uncertaintyScore += 1;
    reasons.push("unknown project kind");
  }

  impactScore = Math.min(4, impactScore);
  complexityScore = Math.min(3, complexityScore);
  uncertaintyScore = Math.min(3, uncertaintyScore);
  operationalScore = Math.min(2, operationalScore);
  const totalScore =
    impactScore + complexityScore + uncertaintyScore + operationalScore;
  const hardHighRisk =
    (/\b(delete|drop|truncate|destroy|reset)\b|删除|清空|销毁|重置/i.test(
      normalizedTask
    ) &&
      (/\b(production|database|credentials?|migration|billing|payment|tables?)\b|生产|数据库|凭据|密钥|迁移|计费|支付|数据表/i.test(
        normalizedTask
      ) ||
        context.sensitivePathsChanged)) ||
    (/\b(migration|migrate|schema|database)\b|迁移|数据库|表结构/i.test(
      normalizedTask
    ) &&
      /\b(auth(?:entication)?|permissions?|security|secrets?|credentials?)\b|鉴权|权限|安全|密钥/i.test(
        normalizedTask
      )) ||
    (context.sensitivePathsChanged &&
      /\b(security|deploy|migration|migrate)\b|安全|部署|迁移/i.test(
        normalizedTask
      )) ||
    (/\b(payment|billing|finance)\b|支付|计费|财务/i.test(normalizedTask) &&
      /\b(auth(?:entication)?|permissions?|security)\b|鉴权|权限|安全/i.test(
        normalizedTask
      ));
  const hardMediumRisk =
    (/\b(api|contract|breaking)\b|接口|破坏性变更/i.test(normalizedTask) &&
      /\b(multiple|many|across|entire|all)\b|多个|跨文件|全量|整个/i.test(
        normalizedTask
      )) ||
    (context.templateId === "refactor-migration" &&
      /\b(refactor|rewrite|architecture|migration|migrate)\b|重构|重写|架构|迁移/i.test(
        normalizedTask
      ));

  const level: RiskAssessment["level"] =
    hardHighRisk || totalScore >= 8
      ? "high"
      : hardMediumRisk || totalScore >= 4
        ? "medium"
        : "low";
  let effectiveMode: EffectiveRunMode;
  let routing: RiskAssessment["routing"];
  let requiresModeApproval = false;

  if (requestedMode === "auto") {
    if (level === "low") {
      effectiveMode = "light";
      routing = "automatic-light";
    } else if (level === "medium") {
      effectiveMode = "full";
      routing = "confirm";
      requiresModeApproval = true;
    } else {
      effectiveMode = "full";
      routing = "forced-full";
    }
  } else if (level === "high" && requestedMode === "light") {
    effectiveMode = "full";
    routing = "forced-full";
    reasons.push("high risk overrides requested light mode");
  } else {
    effectiveMode = requestedMode;
    routing = "explicit";
    reasons.push(`user selected ${requestedMode} mode`);
  }

  if (requestedMode === "auto" && reasons.length === 0) {
    reasons.push("small low-risk task");
  }

  return {
    impactScore,
    complexityScore,
    uncertaintyScore,
    operationalScore,
    totalScore,
    score: totalScore,
    level,
    effectiveMode,
    routing,
    requiresModeApproval,
    reasons,
    context
  };
}

export function applyRiskSignal(
  assessment: RiskAssessment,
  signal: RiskSignalType
): RiskAssessment {
  const next: RiskAssessment = {
    ...assessment,
    context: { ...assessment.context },
    reasons: [...assessment.reasons]
  };
  switch (signal) {
    case "scope-expansion":
      next.complexityScore = Math.min(3, next.complexityScore + 2);
      break;
    case "sensitive-path":
      next.operationalScore = Math.min(2, next.operationalScore + 2);
      next.context.sensitivePathsChanged = true;
      break;
    case "destructive-operation":
      next.impactScore = 4;
      next.operationalScore = Math.min(2, next.operationalScore + 1);
      break;
    case "migration":
      next.impactScore = Math.max(3, next.impactScore);
      next.complexityScore = Math.min(3, next.complexityScore + 1);
      break;
    case "verification-gap":
      next.uncertaintyScore = Math.min(3, next.uncertaintyScore + 2);
      next.context.hasVerification = false;
      break;
  }
  next.reasons.push(`runtime signal: ${signal}`);
  next.totalScore =
    next.impactScore +
    next.complexityScore +
    next.uncertaintyScore +
    next.operationalScore;
  next.score = next.totalScore;
  next.level =
    signal === "destructive-operation" || next.totalScore >= 8
      ? "high"
      : next.totalScore >= 4
        ? "medium"
        : "low";
  if (next.level === "high") {
    next.routing = "forced-full";
    next.effectiveMode = "full";
    next.requiresModeApproval = false;
  }
  return next;
}

import type { EffectiveRunMode, RiskAssessment, RunMode } from "./types.js";

const HIGH_RISK_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(delete|drop|truncate|destroy|reset)\b|删除|清空|销毁/i, 4, "destructive change"],
  [/\b(migration|migrate|schema|database)\b|迁移|数据库|表结构/i, 3, "data migration"],
  [/\b(auth(?:entication)?|permissions?|security|secrets?|credentials?)\b|鉴权|权限|安全|密钥/i, 3, "security-sensitive"],
  [/\b(payment|billing|finance)\b|支付|计费|财务/i, 3, "financial impact"],
  [/\b(deploy|release|production|infra)\b|部署|发布|生产|基础设施/i, 2, "operational impact"],
  [/\b(refactor|rewrite|architecture)\b|重构|重写|架构/i, 2, "broad architectural change"],
  [/\b(api|contract|breaking)\b|接口|破坏性变更/i, 2, "public contract change"],
  [/\b(concurrent|distributed|network)\b|并发|分布式|网络/i, 2, "distributed complexity"]
];

const LARGE_SCOPE_PATTERNS: Array<[RegExp, number, string]> = [
  [/\b(multiple|many|across|entire|all)\b|多个|跨文件|全量|整个/i, 2, "large scope"],
  [/\b(frontend.*backend|full[- ]?stack)\b|前后端|全栈/i, 2, "cross-layer change"],
  [/\b(new feature|implement)\b|新功能|实现/i, 1, "feature delivery"]
];

export function assessRisk(task: string, requestedMode: RunMode): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  for (const [pattern, weight, reason] of [
    ...HIGH_RISK_PATTERNS,
    ...LARGE_SCOPE_PATTERNS
  ]) {
    if (pattern.test(task)) {
      score += weight;
      reasons.push(reason);
    }
  }

  const level: RiskAssessment["level"] =
    score >= 6 ? "high" : score >= 3 ? "medium" : "low";
  const automaticMode: EffectiveRunMode = score >= 3 ? "full" : "light";
  const effectiveMode =
    requestedMode === "auto" ? automaticMode : requestedMode;

  if (requestedMode !== "auto") {
    reasons.push(`user selected ${requestedMode} mode`);
  } else if (reasons.length === 0) {
    reasons.push("small low-risk task");
  }

  return { score, level, effectiveMode, reasons };
}

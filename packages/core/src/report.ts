import { redactSecrets } from "./security.js";
import type { RunEvent, RunSnapshot } from "./types.js";

export function renderRunReport(
  snapshot: RunSnapshot,
  events: RunEvent[]
): string {
  const verificationArtifacts = snapshot.artifacts.filter(
    (artifact) => artifact.roleId === "expert.tester"
  );
  const status =
    snapshot.state === "completed" && snapshot.verificationStatus !== "passed"
      ? "unverified"
      : snapshot.state;

  const lines = [
    `# 神治运行报告 ${snapshot.id}`,
    "",
    `- 状态：${status}`,
    `- 模板：${snapshot.templateId}`,
    `- 模式：${snapshot.mode}`,
    `- 风险：${snapshot.risk.level} (${snapshot.risk.totalScore})`,
    `- 风险维度：impact=${snapshot.risk.impactScore}, complexity=${snapshot.risk.complexityScore}, uncertainty=${snapshot.risk.uncertaintyScore}, operational=${snapshot.risk.operationalScore}`,
    `- 分流：${snapshot.risk.routing}`,
    `- 验证状态：${snapshot.verificationStatus}`,
    `- 基线提交：${snapshot.baselineCommit ?? "不可用"}`,
    `- 工作区含未提交修改：${snapshot.dirtyWorkingTree ? "是" : "否"}`,
    `- 开始：${snapshot.startedAt}`,
    `- 更新：${snapshot.updatedAt}`,
    `- 子 Agent 模型：${snapshot.modelPolicy.model} / ${snapshot.modelPolicy.reasoningEffort}`,
    `- Agent 预算：${snapshot.agentInstances.length}/${snapshot.budget.maxAgents}`,
    `- 当前并发：${snapshot.activeAgents.length}/${snapshot.budget.maxConcurrency}`,
    `- 运行时能力：${snapshot.runtimeCapabilities ? `${snapshot.runtimeCapabilities.host}/${snapshot.runtimeCapabilities.platform} (${snapshot.runtimeCapabilities.reportHash})` : "未登记"}`,
    "",
    "## Agent 实例",
    "",
    ...snapshot.agentInstances.map(
      (instance) =>
        `- ${instance.instanceId}: ${instance.roleId} — ${instance.model} / ${instance.reasoningEffort}`
    ),
    "",
    "## 用户决策",
    "",
    ...snapshot.decisions.map(
      (decision) =>
        `- ${decision.id} [${decision.kind}] ${decision.status}${
          decision.selectedOption ? ` → ${decision.selectedOption}` : ""
        }`
    ),
    "",
    "## 候选工作区",
    "",
    ...snapshot.candidates.map(
      (candidate) =>
        `- ${candidate.id}: ${candidate.status} — ${candidate.branch} — 验证 ${candidate.verificationArtifacts.length} 项`
    ),
    "",
    "## 产物",
    "",
    ...snapshot.artifacts.map(
      (artifact) =>
        `- ${artifact.id}: ${artifact.roleId} — ${artifact.path} — ${artifact.sha256}`
    ),
    "",
    "## 审计事件",
    "",
    ...events.map(
      (event) =>
        `- ${event.sequence}. ${event.timestamp} ${event.type} (${event.actor})`
    )
  ];

  if (
    verificationArtifacts.length === 0 ||
    snapshot.verificationStatus !== "passed"
  ) {
    lines.push(
      "",
      "> 自动化验证证据缺失。本次运行不得标记为“质量通过”。"
    );
  }
  return redactSecrets(lines.join("\n"));
}

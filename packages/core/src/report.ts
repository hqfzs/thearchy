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
    snapshot.state === "completed"
      ? verificationArtifacts.length > 0
        ? "completed"
        : "unverified"
      : snapshot.state;

  const lines = [
    `# 神治运行报告 ${snapshot.id}`,
    "",
    `- 状态：${status}`,
    `- 模板：${snapshot.templateId}`,
    `- 模式：${snapshot.mode}`,
    `- 风险：${snapshot.risk.level} (${snapshot.risk.score})`,
    `- 基线提交：${snapshot.baselineCommit ?? "不可用"}`,
    `- 工作区含未提交修改：${snapshot.dirtyWorkingTree ? "是" : "否"}`,
    `- 开始：${snapshot.startedAt}`,
    `- 更新：${snapshot.updatedAt}`,
    "",
    "## 参与角色",
    "",
    ...snapshot.participants.map((role) => `- ${role}`),
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

  if (verificationArtifacts.length === 0) {
    lines.push(
      "",
      "> 自动化验证证据缺失。本次运行不得标记为“质量通过”。"
    );
  }
  return redactSecrets(lines.join("\n"));
}

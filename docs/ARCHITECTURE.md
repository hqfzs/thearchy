# 架构

## 设计原则

1. 模板是唯一业务来源，适配器只负责平台编译。
2. CLI 协调器是运行状态的唯一权威来源。
3. 规划、实现、验证与裁决通过机器角色 ID 隔离。
4. 所有状态变化写入追加式 JSONL 事件日志。
5. 提示词不能绕过状态、预算、审批和路径边界。

## 组件

- `@thearchy/core`：Schema、角色、风险、状态机、存储、Git 与安全。
- `@thearchy/adapter-codex`：生成 Codex 插件和 Skill。
- `@thearchy/adapter-claude`：生成 Claude Code插件、Agents 与命令。
- `thearchy-cli`：安装、协调、模板、报告和工作区接口。

## 状态数据

Git 项目默认使用 `.git/thearchy/runs/<run-id>`：

- `snapshot.json`：当前快照。
- `events.jsonl`：追加式审计日志。
- `.lock`：运行级互斥锁。

无 Git 项目使用用户目录下的 `.thearchy/state`。

## 适配边界

宿主工具负责模型推理、子 Agent 和工具调用。CLI 不读取模型隐藏推理，只接收结构化产物路径、角色 ID 和审批命令。

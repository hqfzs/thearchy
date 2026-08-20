# 神治（Thearchy）

神治是一套运行在本地 AI 编码工具中的多 Agent 质量治理系统。它不提供新的模型服务，而是在 Codex 与 Claude Code之上加入确定性的规划、裁决、执行、验证和交付状态机。

> 当前版本：`0.2.0-beta.1`。这是可运行的 Beta 版本，不应直接用于未经人工确认的生产发布。

## 核心特性

- 固定机器角色 ID 与希腊神话显示名称。
- 本地 JSONL 审计日志和不可跳过的状态机。
- 轻量、完整两种预算模式。
- 完整模式默认采用4个子 Agent、并发2个、8分钟预算。
- 主 Agent直接负责分类、派工和交付，减少治理开销。
- 方案与成果两道独立裁决。
- Git 基线记录和隔离 worktree。
- Codex 与 Claude Code插件编译器。
- 五套官方团队模板。
- JavaScript/TypeScript 与 Python 验证命令检测。
- 不收集遥测，不需要外部模型 API。

## 安装开发环境

需要 Node.js 22 或更高版本以及 Git。

```bash
npm install
npm test
npm link --workspace packages/cli
thearchy doctor
```

## 安装宿主插件

### Codex 桌面端一键安装

Windows 用户直接双击项目根目录中的：

```text
install-codex-desktop.cmd
```

安装器会自动：

1. 检查 Node.js；
2. 构建自包含协调器；
3. 将插件安装到 Codex 个人插件目录；
4. 注册为 `INSTALLED_BY_DEFAULT`；
5. 打开 Codex 的神治插件页面。

协调器已经嵌入插件，不再需要执行 `npm link` 或全局安装 CLI。

命令行方式：

```bash
thearchy desktop install
thearchy desktop status
thearchy desktop uninstall
```

卸载也可以双击：

```text
uninstall-codex-desktop.cmd
```

### 通用安装

```bash
thearchy install --target codex
thearchy install --target claude
thearchy install --target all
```

Codex 插件默认生成到用户目录下的 `plugins/thearchy`，并更新个人 marketplace。Claude Code插件默认生成到 `~/.thearchy/hosts/claude/thearchy`，可通过以下方式本地验证：

```bash
claude --plugin-dir ~/.thearchy/hosts/claude/thearchy
```

也可使用 `--output` 只编译到指定目录，不修改宿主配置：

```bash
thearchy install --target all --output ./generated
```

## 启动一次运行

```bash
thearchy run start \
  --template feature-delivery \
  --mode auto \
  --task "为项目增加用户登录功能"
```

返回值包含运行 ID。此后宿主 Agent 必须先查询下一步：

```bash
thearchy run next <run-id> --json
```

当返回值包含 `interaction` 时，主 Agent 会优先调用可选项询问组件。选择完成后：

```bash
thearchy run decide <run-id> \
  --request <decision-id> \
  --choice <option-id>
```

创建子 Agent 前必须登记模型和租约：

```bash
thearchy run claim <run-id> \
  --role governance.router \
  --instance router-1 \
  --model gpt-5.6-luna \
  --reasoning-effort max
```

以下治理角色由主 Agent 直接完成，不创建子 Agent：

- `governance.router`
- `governance.dispatcher`
- `governance.publisher`
- 轻量模式下的 `governance.planner`

提交这些产物时使用 `--root`：

```bash
thearchy run submit <run-id> \
  --role governance.router \
  --instance root-main \
  --artifact ./artifacts/classification.md \
  --root
```

保存角色产物后提交：

```bash
thearchy run submit <run-id> \
  --role governance.router \
  --instance router-1 \
  --artifact ./artifacts/classification.md
```

专家执行阶段的最后一项产物使用 `--final`，触发验证阶段：

```bash
thearchy run submit <run-id> \
  --role expert.builder \
  --instance builder-1 \
  --artifact ./artifacts/implementation.md \
  --final
```

长时间运行的子 Agent 需要续租：

```bash
thearchy run heartbeat <run-id> --instance builder-1
```

高风险操作必须先发起询问：

```bash
thearchy run request-operation <run-id> \
  --type dependency-install \
  --summary "安装新的鉴权依赖"
```

审批：

```bash
thearchy run approve <run-id> --gate plan
thearchy run approve <run-id> --gate merge
```

拒绝与返工：

```bash
thearchy run reject <run-id> --gate plan --reason "缺少回滚方案"
thearchy run resume <run-id>
```

## 官方模板

| ID | 名称 |
|---|---|
| `feature-delivery` | 功能开发 |
| `bug-repair` | Bug 修复 |
| `code-review` | 代码审查 |
| `security-review` | 安全审查 |
| `refactor-migration` | 重构迁移 |

## Git 规则

- 完整模式以启动时的 `HEAD` 为基线。
- 未提交修改不会进入候选 worktree。
- 神治不会自动 stash 或提交用户修改。
- 用户必须查看 diff、测试和裁决证据后批准合并。
- 完整模式可以比较多个候选，并由询问组件选择最终候选。

## 安全规则

- `.env`、SSH、云凭据等秘密路径默认禁止。
- 远程模板仅允许 YAML、Markdown、JSON 和静态图片。
- 远程模板不能包含脚本、Hooks 或命令。
- 网络、依赖安装、删除、迁移、发布与外部写入需要批准。
- 无测试证据的结果只能标记为 `unverified`。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [Codex 桌面端安装](docs/CODEX-DESKTOP.md)
- [模板规范](docs/TEMPLATE-SPEC.md)
- [威胁模型](docs/THREAT-MODEL.md)
- [质量评测](evals/README.md)
- [English quick start](README.en.md)

## 许可证

Apache-2.0

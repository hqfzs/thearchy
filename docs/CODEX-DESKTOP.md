# Codex 桌面端安装

这是神治首个正式版本的主要支持目标，运行环境为 Windows。

## 一键安装

Windows 用户双击项目根目录中的：

```text
install-codex-desktop.cmd
```

安装器会完成依赖检查、构建、插件复制、个人 marketplace 注册和
Codex deeplink 启动。插件使用 `INSTALLED_BY_DEFAULT` 策略。

也可以从终端执行：

```powershell
cd D:\project\thearchy
npm ci
npm run build
node packages\cli\dist\bin\thearchy.js desktop install
```

从 npm 安装时可执行：

```bash
npx thearchy-cli desktop install
```

## 自包含协调器

Codex 插件包含：

```text
skills/thearchy/scripts/thearchy.js
skills/thearchy/scripts/assets/
```

协调器、模板和角色资源均随插件复制，不依赖全局 `thearchy` 命令。
运行机器仍需提供 Node.js 22 或更高版本。

## 检查状态

```bash
thearchy desktop status
```

三个字段都应为 `true`：

- `pluginInstalled`
- `marketplaceRegistered`
- `runtimeInstalled`

运行中的关键决策会优先调用 MCP 可选项询问组件；如果不可用则使用 Codex 原生可选项输入，最后才退回结构化文本询问。

`auto` 模式采用自适应分流：低风险任务直接进入轻量模式，中风险任务询问用户，高风险任务强制进入完整模式。轻量模式只创建一个领域专家和一个独立验证者，并按顺序执行。

## 使用

Codex 打开后新建任务，输入：

```text
使用神治完整模式实现这个需求，并在修改代码前让我确认方案。
```

## 模型策略

- 根主 Agent 保持用户当前选择的模型和推理强度，不做修改。
- 所有治理角色与动态专家子 Agent 使用：
  - 模型：`gpt-5.6-luna`
  - 推理强度：`max`
- 如果当前环境无法使用该模型，插件应明确报告错误，不静默降级。

安装或升级插件后应新建任务，避免旧任务继续使用缓存的 Skill。

## 卸载

双击：

```text
uninstall-codex-desktop.cmd
```

或执行：

```bash
thearchy desktop uninstall
```

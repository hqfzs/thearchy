# TeamTemplate v1alpha1

模板必须使用：

```yaml
apiVersion: thearchy.dev/v1alpha1
kind: TeamTemplate
```

## 稳定引用

- 模板使用 `metadata.id` 作为永久 ID。
- 角色只能使用 `governance.*` 或 `expert.*` 机器 ID。
- 显示名称和语言不得作为逻辑引用。
- `metadata.version` 必须使用 SemVer。

## 远程模板限制

远程模板不得包含：

- 可执行脚本；
- Hooks；
- Shell 命令；
- 二进制程序；
- 越出模板根目录的符号链接。

模板只能请求 `test`、`lint`、`build`、`typecheck`、`security-scan` 能力。实际命令由核心从项目文件中检测。

权限字段包括：

- `network`
- `dependencyInstall`
- `destructive`
- `externalWrite`
- `sensitiveRead`

值只能是 `deny` 或 `approval`。`approval` 表示必须产生风险决策并等待询问组件结果。

## 版本策略

- `v1alpha1` 允许在 Beta 期间演进。
- API 版本改变时必须提供显式迁移器。
- 不识别的版本必须拒绝，禁止静默猜测。

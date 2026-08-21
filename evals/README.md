# 质量评测

`cases.json` 定义10个固定任务：五套模板各两个，JavaScript 与 Python 各五个。

每个任务需要运行两组：

1. 宿主工具的单 Agent 默认流程；
2. 神治对应模板的完整模式。

记录：

- 是否完成任务；
- 自动化测试是否通过；
- 种植缺陷发现数量；
- 新增回归数量；
- 总耗时；
- 参与 Agent 数；
- 宿主能够提供的 Token 或调用量。

模型评测结果不得提交真实凭据、私有仓库内容或完整隐藏推理。结果文件使用 `results/<date>-<host>.json`，并按照 `results.schema.json` 校验。

## Windows / Codex 路由与轻量模式基准

```bash
npm run benchmark:routing-light
```

该基准使用10个固定风险场景，每个运行3次，检查上下文风险分类、模式询问频率、完整状态流和轻量模式双子 Agent 上限。它只测确定性协调层，不替代真实模型质量评测。

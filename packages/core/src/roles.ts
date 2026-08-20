import type { RoleDefinition } from "./types.js";

export const GOVERNANCE_ROLES: readonly RoleDefinition[] = [
  {
    id: "governance.router",
    displayName: "赫尔墨斯｜信使",
    englishName: "Hermes | Messenger",
    responsibility: "接收需求、风险分类、模式选择",
    tier: "fast",
    governance: true
  },
  {
    id: "governance.planner",
    displayName: "雅典娜｜智慧女神",
    englishName: "Athena | Strategist",
    responsibility: "候选方案、架构和任务拆解",
    tier: "reasoning",
    governance: true
  },
  {
    id: "governance.judge",
    displayName: "宙斯｜众神裁决者",
    englishName: "Zeus | Judge",
    responsibility: "方案封驳和成果裁决",
    tier: "review",
    governance: true
  },
  {
    id: "governance.dispatcher",
    displayName: "赫拉｜众神协调者",
    englishName: "Hera | Coordinator",
    responsibility: "工单、状态和 Agent 调度",
    tier: "reasoning",
    governance: true
  },
  {
    id: "governance.publisher",
    displayName: "阿波罗｜神谕发布者",
    englishName: "Apollo | Publisher",
    responsibility: "证据报告、合并和可选 PR",
    tier: "review",
    governance: true
  }
] as const;

export const EXPERT_ROLES: readonly RoleDefinition[] = [
  {
    id: "expert.builder",
    displayName: "普罗米修斯｜创造者",
    englishName: "Prometheus | Builder",
    responsibility: "功能实现",
    tier: "reasoning",
    governance: false
  },
  {
    id: "expert.tester",
    displayName: "阿耳忒弥斯｜猎手",
    englishName: "Artemis | Tester",
    responsibility: "测试与回归",
    tier: "review",
    governance: false
  },
  {
    id: "expert.debugger",
    displayName: "奥德修斯｜智谋者",
    englishName: "Odysseus | Debugger",
    responsibility: "Bug 定位与根因分析",
    tier: "reasoning",
    governance: false
  },
  {
    id: "expert.security",
    displayName: "地狱三头犬｜守门者",
    englishName: "Cerberus | Security Guardian",
    responsibility: "安全与权限审查",
    tier: "review",
    governance: false
  },
  {
    id: "expert.architect",
    displayName: "阿特拉斯｜承载者",
    englishName: "Atlas | Architect",
    responsibility: "架构与稳定性",
    tier: "reasoning",
    governance: false
  },
  {
    id: "expert.documenter",
    displayName: "缪斯女神｜记录者",
    englishName: "The Muses | Documenter",
    responsibility: "API、规范与文档",
    tier: "fast",
    governance: false
  },
  {
    id: "expert.data",
    displayName: "波塞冬｜潮汐掌控者",
    englishName: "Poseidon | Data Specialist",
    responsibility: "数据、存储与性能",
    tier: "reasoning",
    governance: false
  },
  {
    id: "expert.operations",
    displayName: "阿瑞斯｜战争指挥官",
    englishName: "Ares | Operations",
    responsibility: "CI/CD、部署与故障响应",
    tier: "reasoning",
    governance: false
  },
  {
    id: "expert.migrator",
    displayName: "赫拉克勒斯｜大力神",
    englishName: "Heracles | Migrator",
    responsibility: "重构、迁移与技术债",
    tier: "reasoning",
    governance: false
  }
] as const;

export const ALL_ROLES: readonly RoleDefinition[] = [
  ...GOVERNANCE_ROLES,
  ...EXPERT_ROLES
];

export const ROLE_BY_ID = new Map(ALL_ROLES.map((role) => [role.id, role]));

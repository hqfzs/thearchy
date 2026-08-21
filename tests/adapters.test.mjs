import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ALL_ROLES,
  loadTemplates
} from "../packages/core/dist/index.js";
import { CodexAdapter } from "../packages/adapter-codex/dist/index.js";
import { ClaudeAdapter } from "../packages/adapter-claude/dist/index.js";

test("both adapters compile from the same template IR", async () => {
  const templates = await loadTemplates(resolve("templates"));
  const directory = await mkdtemp(join(tmpdir(), "thearchy-adapters-"));
  const codexPath = join(directory, "codex");
  const claudePath = join(directory, "claude");
  const codex = await new CodexAdapter().compile(codexPath, templates, [...ALL_ROLES]);
  const claude = await new ClaudeAdapter().compile(
    claudePath,
    templates,
    [...ALL_ROLES]
  );

  assert.equal(codex.host, "codex");
  assert.equal(claude.host, "claude");
  await access(join(codexPath, ".codex-plugin", "plugin.json"));
  await access(join(codexPath, "skills", "thearchy", "SKILL.md"));
  await access(join(claudePath, ".claude-plugin", "plugin.json"));
  await access(join(claudePath, "commands", "thearchy.md"));
  await access(join(claudePath, "agents", "governance-judge.md"));
});

test("Codex capabilities describe the desktop host contract, not PATH lookup", async () => {
  const capabilities = await new CodexAdapter().detect();
  assert.equal(capabilities.subagents, true);
  assert.equal(capabilities.parallelAgents, true);
  assert.equal(capabilities.mcp, true);
});

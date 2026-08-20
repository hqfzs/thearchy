import { rm } from "node:fs/promises";

for (const path of [
  "packages/core/dist",
  "packages/adapter-codex/dist",
  "packages/adapter-claude/dist",
  "packages/cli/dist"
]) {
  await rm(path, { recursive: true, force: true });
}

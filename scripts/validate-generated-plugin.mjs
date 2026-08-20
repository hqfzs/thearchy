import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = await mkdtemp(join(tmpdir(), "thearchy-plugin-validation-"));
const cli = resolve("packages/cli/dist/bin/thearchy.js");
const result = spawnSync(
  process.execPath,
  [cli, "install", "--target", "codex", "--output", output],
  { encoding: "utf8", windowsHide: true }
);
if (result.status !== 0) throw new Error(result.stderr || result.stdout);

const manifest = JSON.parse(
  await readFile(join(output, ".codex-plugin", "plugin.json"), "utf8")
);
if (manifest.name !== "thearchy") throw new Error("Invalid plugin name");
if (!/^\d+\.\d+\.\d+-beta\.\d+\+codex\.local-\d{14}$/.test(manifest.version)) {
  throw new Error(`Invalid plugin version: ${manifest.version}`);
}
for (const key of ["composerIcon", "logo", "logoDark"]) {
  const path = manifest.interface?.[key];
  if (typeof path !== "string") throw new Error(`Missing interface.${key}`);
  await access(join(output, path.replace(/^\.\//, "")));
}

const skill = await readFile(join(output, "skills", "thearchy", "SKILL.md"), "utf8");
for (const required of [
  "mcp__choice_prompt__ask_user_choice",
  "request_user_input",
  "run decide",
  "run request-operation",
  "--instance root-main --root",
  "four child agents",
  "gpt-5.6-luna",
  "reasoning_effort: max"
]) {
  if (!skill.includes(required)) throw new Error(`Skill missing: ${required}`);
}
try {
  await access(
    join(output, "skills", "thearchy", "scripts", "assets", "skills", "thearchy", "SKILL.md")
  );
  throw new Error("Duplicate nested Skill was generated");
} catch (error) {
  if (error instanceof Error && error.message === "Duplicate nested Skill was generated") {
    throw error;
  }
}

process.stdout.write("Generated Codex plugin validation passed.\n");

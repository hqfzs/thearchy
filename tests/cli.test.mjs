import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("packages/cli/dist/bin/thearchy.js");

function run(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

test("bundled CLI reports its version and templates", () => {
  assert.equal(run(["--version"]), "0.1.0-beta.0");
  const templates = JSON.parse(run(["template", "list"]));
  assert.equal(templates.length, 5);
  assert.ok(templates.some((template) => template.id === "feature-delivery"));
});

test("bundled CLI compiles Codex and Claude adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-cli-install-"));
  const output = join(directory, "generated");
  const result = JSON.parse(
    run(["install", "--target", "all", "--output", output], directory)
  );
  assert.equal(result.length, 2);
  await access(join(output, "codex", ".codex-plugin", "plugin.json"));
  await access(join(output, "claude", ".claude-plugin", "plugin.json"));
});

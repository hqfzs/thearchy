import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("packages/cli/dist/bin/thearchy.js");

function run(args, cwd = process.cwd(), env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env }
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
  await access(
    join(
      output,
      "codex",
      "skills",
      "thearchy",
      "scripts",
      "thearchy.js"
    )
  );
  await access(join(output, "claude", ".claude-plugin", "plugin.json"));
});

test("embedded coordinator runs without a global CLI installation", () => {
  const embedded = resolve("packages/cli/dist/embedded/thearchy.js");
  const result = spawnSync(process.execPath, [embedded, "--version"], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0-beta.0");
});

test("desktop install registers an installed-by-default personal plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-desktop-"));
  const pluginPath = join(directory, "plugins", "thearchy");
  const marketplacePath = join(
    directory,
    ".agents",
    "plugins",
    "marketplace.json"
  );
  const env = {
    THEARCHY_CODEX_PLUGIN_DIR: pluginPath,
    THEARCHY_CODEX_MARKETPLACE: marketplacePath
  };
  const installed = JSON.parse(
    run(["desktop", "install", "--no-launch"], directory, env)
  );
  assert.equal(installed.status.pluginInstalled, true);
  assert.equal(installed.status.runtimeInstalled, true);
  assert.equal(installed.status.marketplaceRegistered, true);

  const marketplace = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(marketplacePath, "utf8")
    )
  );
  assert.equal(
    marketplace.plugins[0].policy.installation,
    "INSTALLED_BY_DEFAULT"
  );
  await access(
    join(pluginPath, "skills", "thearchy", "scripts", "assets", "templates")
  );
  const embeddedRuntime = join(
    pluginPath,
    "skills",
    "thearchy",
    "scripts",
    "thearchy.js"
  );
  const runtime = spawnSync(process.execPath, [embeddedRuntime, "template", "list"], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.equal(JSON.parse(runtime.stdout).length, 5);

  const status = JSON.parse(run(["desktop", "status"], directory, env));
  assert.equal(status.runtimeInstalled, true);

  const removed = JSON.parse(
    run(["desktop", "uninstall"], directory, env)
  );
  assert.equal(removed.pluginInstalled, false);
  assert.equal(removed.marketplaceRegistered, false);
});

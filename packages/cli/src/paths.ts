import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGitBaseline } from "@thearchy/core";

export function packageRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return basename(current) === "bin" ? dirname(current) : current;
}

export function assetsDirectory(): string {
  return join(packageRoot(), "assets");
}

export function builtinTemplatesDirectory(): string {
  return join(assetsDirectory(), "templates");
}

export function thearchyHome(): string {
  return process.env.THEARCHY_HOME
    ? process.env.THEARCHY_HOME
    : join(homedir(), ".thearchy");
}

export function stateDirectory(cwd: string): string {
  const baseline = inspectGitBaseline(cwd);
  if (baseline.repositoryRoot) {
    return join(baseline.repositoryRoot, ".git", "thearchy");
  }
  return join(thearchyHome(), "state");
}

export function userTemplatesDirectory(): string {
  return join(thearchyHome(), "templates");
}

export function hostOutputDirectory(host: "codex" | "claude"): string {
  if (host === "codex") {
    return (
      process.env.THEARCHY_CODEX_PLUGIN_DIR ??
      join(homedir(), "plugins", "thearchy")
    );
  }
  return join(thearchyHome(), "hosts", "claude", "thearchy");
}

export function codexMarketplacePath(): string {
  return (
    process.env.THEARCHY_CODEX_MARKETPLACE ??
    join(homedir(), ".agents", "plugins", "marketplace.json")
  );
}

export function embeddedRuntimePath(): string {
  return join(packageRoot(), "embedded", "thearchy.js");
}

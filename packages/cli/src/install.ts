import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALL_ROLES,
  type AdapterCompileResult,
  type HostAdapter
} from "@thearchy/core";
import { CodexAdapter } from "@thearchy/adapter-codex";
import { ClaudeAdapter } from "@thearchy/adapter-claude";
import { allTemplates } from "./templates.js";
import { hostOutputDirectory } from "./paths.js";

function adapter(host: "codex" | "claude"): HostAdapter {
  return host === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

async function backup(path: string): Promise<string | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  const destination = `${path}.thearchy-backup-${Date.now()}`;
  await cp(path, destination, { recursive: true });
  return destination;
}

async function updateCodexMarketplace(pluginPath: string): Promise<string> {
  const marketplacePath = join(homedir(), ".agents", "plugins", "marketplace.json");
  await mkdir(dirname(marketplacePath), { recursive: true });
  let marketplace: {
    name: string;
    interface: { displayName: string };
    plugins: Array<Record<string, unknown>>;
  } = {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: []
  };
  try {
    marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as typeof marketplace;
  } catch {
    // Seed the default personal marketplace.
  }
  const entry = {
    name: "thearchy",
    source: { source: "local", path: "./plugins/thearchy" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools"
  };
  marketplace.plugins = marketplace.plugins.filter(
    (item) => item.name !== "thearchy"
  );
  marketplace.plugins.push(entry);
  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2));
  return marketplacePath;
}

export async function installHosts(
  hosts: Array<"codex" | "claude">,
  customOutput?: string
): Promise<AdapterCompileResult[]> {
  const templates = await allTemplates();
  const results: AdapterCompileResult[] = [];
  for (const host of hosts) {
    const output =
      customOutput && hosts.length === 1
        ? customOutput
        : customOutput
          ? join(customOutput, host)
          : hostOutputDirectory(host);
    await backup(output);
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const result = await adapter(host).compile(output, templates, [...ALL_ROLES]);
    if (host === "codex" && !customOutput) {
      result.nextSteps.push(
        `Codex personal marketplace updated: ${await updateCodexMarketplace(output)}`
      );
    }
    results.push(result);
  }
  return results;
}

export async function uninstallHosts(
  hosts: Array<"codex" | "claude">
): Promise<void> {
  for (const host of hosts) {
    await rm(hostOutputDirectory(host), { recursive: true, force: true });
  }
  if (hosts.includes("codex")) {
    const marketplacePath = join(homedir(), ".agents", "plugins", "marketplace.json");
    try {
      const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
        plugins?: Array<Record<string, unknown>>;
      };
      marketplace.plugins = (marketplace.plugins ?? []).filter(
        (item) => item.name !== "thearchy"
      );
      const temporary = `${marketplacePath}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(marketplace, null, 2));
      await rename(temporary, marketplacePath);
    } catch {
      // Missing marketplace is already uninstalled.
    }
  }
}

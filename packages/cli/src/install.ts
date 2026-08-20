import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ALL_ROLES,
  type AdapterCompileResult,
  type HostAdapter
} from "@thearchy/core";
import { CodexAdapter } from "@thearchy/adapter-codex";
import { ClaudeAdapter } from "@thearchy/adapter-claude";
import { allTemplates } from "./templates.js";
import {
  assetsDirectory,
  codexMarketplacePath,
  embeddedRuntimePath,
  hostOutputDirectory
} from "./paths.js";

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

async function updateCodexMarketplace(): Promise<string> {
  const marketplacePath = codexMarketplacePath();
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
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_INSTALL"
    },
    category: "Developer Tools"
  };
  marketplace.plugins = marketplace.plugins.filter(
    (item) => item.name !== "thearchy"
  );
  marketplace.plugins.push(entry);
  await backup(marketplacePath);
  const temporary = `${marketplacePath}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(marketplace, null, 2));
  await rename(temporary, marketplacePath);
  return marketplacePath;
}

async function installEmbeddedCoordinator(output: string): Promise<{
  runtimePath: string;
  command: string;
  files: string[];
}> {
  const scriptsDirectory = join(output, "skills", "thearchy", "scripts");
  const runtimePath = join(scriptsDirectory, "thearchy.js");
  const runtimeAssets = join(scriptsDirectory, "assets");
  await mkdir(scriptsDirectory, { recursive: true });
  await cp(embeddedRuntimePath(), runtimePath, { force: true });
  await mkdir(runtimeAssets, { recursive: true });
  await cp(
    join(assetsDirectory(), "templates"),
    join(runtimeAssets, "templates"),
    { recursive: true, force: true }
  );

  const command = `node "${runtimePath}"`;
  const windowsLauncher = join(scriptsDirectory, "thearchy.cmd");
  await writeFile(
    windowsLauncher,
    `@echo off\r\nnode "%~dp0thearchy.js" %*\r\n`
  );
  return {
    runtimePath,
    command,
    files: [runtimePath, windowsLauncher]
  };
}

export function codexPluginDeepLink(): string {
  return `codex://plugins/thearchy?marketplacePath=${encodeURIComponent(
    codexMarketplacePath()
  )}`;
}

export interface DesktopInstallStatus {
  pluginPath: string;
  marketplacePath: string;
  runtimePath: string;
  pluginInstalled: boolean;
  marketplaceRegistered: boolean;
  runtimeInstalled: boolean;
  deepLink: string;
}

export async function codexDesktopStatus(): Promise<DesktopInstallStatus> {
  const pluginPath = hostOutputDirectory("codex");
  const marketplacePath = codexMarketplacePath();
  const runtimePath = join(
    pluginPath,
    "skills",
    "thearchy",
    "scripts",
    "thearchy.js"
  );
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  let marketplaceRegistered = false;
  try {
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      plugins?: Array<{ name?: string; policy?: { installation?: string } }>;
    };
    marketplaceRegistered = (marketplace.plugins ?? []).some(
      (entry) =>
        entry.name === "thearchy" &&
        entry.policy?.installation === "INSTALLED_BY_DEFAULT"
    );
  } catch {
    marketplaceRegistered = false;
  }
  return {
    pluginPath,
    marketplacePath,
    runtimePath,
    pluginInstalled: await exists(join(pluginPath, ".codex-plugin", "plugin.json")),
    marketplaceRegistered,
    runtimeInstalled: await exists(runtimePath),
    deepLink: codexPluginDeepLink()
  };
}

export async function installHosts(
  hosts: Array<"codex" | "claude">,
  customOutput?: string
): Promise<AdapterCompileResult[]> {
  const templates = await allTemplates();
  const results: AdapterCompileResult[] = [];
  const cachebuster = new Date()
    .toISOString()
    .replaceAll(/[-:TZ.]/g, "")
    .slice(0, 14);
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
    const embedded =
      host === "codex" ? await installEmbeddedCoordinator(output) : undefined;
    const result = await adapter(host).compile(output, templates, [...ALL_ROLES], {
      ...(embedded ? { runtimeCommand: embedded.command } : {}),
      desktopInstall: host === "codex",
      ...(host === "codex"
        ? {
            pluginAssetsDirectory: join(assetsDirectory(), "assets"),
            version: `0.2.0-beta.1+codex.local-${cachebuster}`,
            subagentModel: "gpt-5.6-luna",
            subagentReasoningEffort: "max",
            preserveMainModel: true
          }
        : {})
    });
    if (embedded) result.files.push(...embedded.files);
    if (host === "codex" && !customOutput) {
      result.nextSteps.push(
        `Codex personal marketplace updated: ${await updateCodexMarketplace()}`,
        `Open Codex: ${codexPluginDeepLink()}`
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
    const marketplacePath = codexMarketplacePath();
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

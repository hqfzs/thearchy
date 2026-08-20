#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ALL_ROLES,
  Coordinator,
  RunStore,
  candidateDiffSummary,
  createWorktree,
  detectVerificationCommands,
  inspectGitBaseline,
  listWorktrees,
  loadTemplates,
  mergeCandidate,
  removeWorktree,
  renderRunReport,
  assertPathInside,
  type OperationType,
  type RunMode
} from "@thearchy/core";
import { ClaudeAdapter } from "@thearchy/adapter-claude";
import { CodexAdapter } from "@thearchy/adapter-codex";
import {
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
  type ParsedArgs
} from "./args.js";
import {
  codexDesktopStatus,
  installHosts,
  uninstallHosts
} from "./install.js";
import { launchExternalUrl } from "./desktop.js";
import { stateDirectory } from "./paths.js";
import {
  addTemplate,
  allTemplates,
  findTemplate,
  removeTemplate
} from "./templates.js";

const VERSION = "0.2.0-beta.1";

function output(value: unknown, json = false): void {
  if (typeof value === "string" && !json) {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `神治 / Thearchy ${VERSION}

Usage:
  thearchy install --target codex|claude|all [--output path]
  thearchy desktop install [--no-launch]
  thearchy desktop status
  thearchy desktop uninstall
  thearchy doctor
  thearchy run start --template <id> --task <text> [--mode auto|light|full]
  thearchy run next <run-id> [--json]
  thearchy run claim <run-id> --role <role-id> --instance <instance-id>
    --model gpt-5.6-luna --reasoning-effort max
  thearchy run submit <run-id> --role <role-id> --instance <instance-id> --artifact <path> [--final]
    [--root]
  thearchy run release <run-id> --instance <instance-id>
  thearchy run heartbeat <run-id> --instance <instance-id>
  thearchy run recover-stale <run-id>
  thearchy run decide <run-id> --request <decision-id> --choice <option-id>
  thearchy run request-operation <run-id> --type <type> --summary <text>
  thearchy run approve <run-id> --gate plan|merge
  thearchy run reject <run-id> --gate plan|result --reason <text>
  thearchy run status|resume|cancel <run-id> [--json]
  thearchy template list
  thearchy template add <local-path-or-github-url>
  thearchy template remove <template-id>
  thearchy template validate <path>
  thearchy workspace baseline
  thearchy workspace create --run <run-id> --candidate <name>
  thearchy workspace candidates --run <run-id>
  thearchy workspace verify --run <run-id> --candidate <name> --artifact <path>
  thearchy workspace compare --run <run-id>
  thearchy workspace integrate --run <run-id>
  thearchy workspace list
  thearchy workspace cleanup --path <worktree-path> [--force]
  thearchy report export <run-id> [--output path]
  thearchy uninstall --target codex|claude|all
`;
}

function hosts(value: string | undefined): Array<"codex" | "claude"> {
  if (!value || value === "all") return ["codex", "claude"];
  if (value === "codex" || value === "claude") return [value];
  throw new Error("--target must be codex, claude, or all");
}

function coordinator(cwd = process.cwd()): Coordinator {
  return new Coordinator(new RunStore(stateDirectory(cwd)));
}

async function handleRun(command: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (!command) throw new Error("Missing run command");
  const service = coordinator();
  const id = parsed.positionals[2];
  switch (command) {
    case "start": {
      const templateId = optionString(parsed, "template", true)!;
      const task = optionString(parsed, "task", true)!;
      const rawMode = optionString(parsed, "mode") ?? "auto";
      if (!["auto", "light", "full"].includes(rawMode)) {
        throw new Error("--mode must be auto, light, or full");
      }
      const budgetOverrides = {
        ...(optionNumber(parsed, "max-agents") === undefined
          ? {}
          : { maxAgents: optionNumber(parsed, "max-agents")! }),
        ...(optionNumber(parsed, "max-concurrency") === undefined
          ? {}
          : { maxConcurrency: optionNumber(parsed, "max-concurrency")! }),
        ...(optionNumber(parsed, "timeout") === undefined
          ? {}
          : { timeoutMinutes: optionNumber(parsed, "timeout")! })
      };
      const snapshot = await service.start({
        task,
        template: await findTemplate(templateId),
        requestedMode: rawMode as RunMode,
        cwd: process.cwd(),
        budgetOverrides
      });
      output(snapshot, true);
      return;
    }
    case "next":
      if (!id) throw new Error("Missing run id");
      output(await service.next(id), true);
      return;
    case "status":
      if (!id) throw new Error("Missing run id");
      output(await service.status(id), optionBoolean(parsed, "json"));
      return;
    case "claim":
      if (!id) throw new Error("Missing run id");
      output(
        await service.claim(
          id,
          optionString(parsed, "role", true)!,
          optionString(parsed, "instance", true)!,
          optionString(parsed, "model", true)!,
          optionString(parsed, "reasoning-effort", true)!
        ),
        true
      );
      return;
    case "heartbeat":
      if (!id) throw new Error("Missing run id");
      output(
        await service.heartbeat(id, optionString(parsed, "instance", true)!),
        true
      );
      return;
    case "recover-stale":
      if (!id) throw new Error("Missing run id");
      output(await service.recoverStale(id), true);
      return;
    case "decide":
      if (!id) throw new Error("Missing run id");
      output(
        await service.decide(
          id,
          optionString(parsed, "request", true)!,
          optionString(parsed, "choice", true)!
        ),
        true
      );
      return;
    case "request-operation": {
      if (!id) throw new Error("Missing run id");
      const type = optionString(parsed, "type", true)!;
      const validTypes = [
        "network",
        "dependency-install",
        "destructive",
        "migration",
        "publish",
        "external-write",
        "sensitive-read"
      ];
      if (!validTypes.includes(type)) {
        throw new Error(`Unsupported operation type: ${type}`);
      }
      output(
        await service.requestOperation({
          runId: id,
          type: type as OperationType,
          summary: optionString(parsed, "summary", true)!
        }),
        true
      );
      return;
    }
    case "submit":
      if (!id) throw new Error("Missing run id");
      output(
        await service.submit({
          runId: id,
          roleId: optionString(parsed, "role", true)!,
          instanceId: optionString(parsed, "instance", true)!,
          artifactPath: optionString(parsed, "artifact", true)!,
          final: optionBoolean(parsed, "final"),
          rootManaged: optionBoolean(parsed, "root")
        }),
        true
      );
      return;
    case "release":
      if (!id) throw new Error("Missing run id");
      output(
        await service.release(id, optionString(parsed, "instance", true)!),
        true
      );
      return;
    case "approve": {
      if (!id) throw new Error("Missing run id");
      const gate = optionString(parsed, "gate", true);
      if (gate !== "plan" && gate !== "merge") {
        throw new Error("--gate must be plan or merge");
      }
      output(await service.approve(id, gate), true);
      return;
    }
    case "reject": {
      if (!id) throw new Error("Missing run id");
      const gate = optionString(parsed, "gate", true);
      if (gate !== "plan" && gate !== "result") {
        throw new Error("--gate must be plan or result");
      }
      output(
        await service.reject(
          id,
          gate,
          optionString(parsed, "reason", true)!
        ),
        true
      );
      return;
    }
    case "resume":
      if (!id) throw new Error("Missing run id");
      output(await service.resume(id), true);
      return;
    case "cancel":
      if (!id) throw new Error("Missing run id");
      output(await service.cancel(id), true);
      return;
    default:
      throw new Error(`Unknown run command: ${command}`);
  }
}

async function handleTemplate(
  command: string | undefined,
  parsed: ParsedArgs
): Promise<void> {
  switch (command) {
    case "list":
      output(
        (await allTemplates()).map((template) => ({
          id: template.metadata.id,
          version: template.metadata.version,
          displayName: template.metadata.displayName
        })),
        true
      );
      return;
    case "add": {
      const source = parsed.positionals[2];
      if (!source) throw new Error("Missing template source");
      output(await addTemplate(source), true);
      return;
    }
    case "remove": {
      const id = parsed.positionals[2];
      if (!id) throw new Error("Missing template id");
      await removeTemplate(id);
      output(`Removed user template ${id}`);
      return;
    }
    case "validate": {
      const path = parsed.positionals[2];
      if (!path) throw new Error("Missing template path");
      const templates = await loadTemplates(resolve(path));
      output(
        templates.map((template) => ({
          id: template.metadata.id,
          version: template.metadata.version,
          valid: true
        })),
        true
      );
      return;
    }
    default:
      throw new Error(`Unknown template command: ${String(command)}`);
  }
}

async function handleWorkspace(
  command: string | undefined,
  parsed: ParsedArgs
): Promise<void> {
  const baseline = inspectGitBaseline(process.cwd());
  if (!baseline.repositoryRoot) {
    throw new Error("Workspace commands require a Git repository");
  }
  switch (command) {
    case "baseline":
      output(baseline, true);
      return;
    case "list":
      output(listWorktrees(baseline.repositoryRoot), true);
      return;
    case "create": {
      const id = optionString(parsed, "run", true)!;
      const candidate = optionString(parsed, "candidate", true)!;
      const snapshot = await coordinator().status(id);
      if (snapshot.mode !== "full") {
        throw new Error("Competing worktrees require full mode");
      }
      if (snapshot.dirtyWorkingTree) {
        throw new Error(
          "The run started with uncommitted changes. Commit them or use light mode."
        );
      }
      const worktree = await createWorktree(
        baseline.repositoryRoot,
        id,
        candidate,
        undefined,
        snapshot.baselineCommit
      );
      await coordinator().registerCandidate(id, {
        id: candidate,
        branch: worktree.branch,
        path: worktree.path,
        baselineCommit: worktree.baselineCommit
      });
      output(worktree, true);
      return;
    }
    case "candidates": {
      const id = optionString(parsed, "run", true)!;
      output((await coordinator().status(id)).candidates, true);
      return;
    }
    case "verify": {
      const id = optionString(parsed, "run", true)!;
      output(
        await coordinator().verifyCandidate(
          id,
          optionString(parsed, "candidate", true)!,
          optionString(parsed, "artifact", true)!
        ),
        true
      );
      return;
    }
    case "compare": {
      const id = optionString(parsed, "run", true)!;
      const snapshot = await coordinator().status(id);
      if (!snapshot.repositoryRoot || !snapshot.baselineCommit) {
        throw new Error("Run does not have a Git baseline");
      }
      output(
        snapshot.candidates.map((candidate) => ({
          id: candidate.id,
          status: candidate.status,
          verificationArtifacts: candidate.verificationArtifacts,
          diff: candidateDiffSummary(
            snapshot.repositoryRoot!,
            snapshot.baselineCommit!,
            candidate.branch
          )
        })),
        true
      );
      return;
    }
    case "integrate": {
      const id = optionString(parsed, "run", true)!;
      const service = coordinator();
      const snapshot = await service.status(id);
      if (snapshot.state !== "integrating") {
        throw new Error(`Run must be integrating, not ${snapshot.state}`);
      }
      if (!snapshot.repositoryRoot || !snapshot.selectedCandidateId) {
        throw new Error("No selected workspace candidate");
      }
      const candidate = snapshot.candidates.find(
        (item) => item.id === snapshot.selectedCandidateId
      );
      if (!candidate) throw new Error("Selected candidate is missing");
      const result = mergeCandidate(snapshot.repositoryRoot, candidate.branch);
      if (result.success && result.commit) {
        await service.markCandidateIntegrated(id, candidate.id, result.commit);
      } else if (result.conflicted) {
        await service.markCandidateConflict(id, candidate.id, result.message);
      }
      output(result, true);
      return;
    }
    case "cleanup": {
      const path = optionString(parsed, "path", true)!;
      const allowedRoot = join(
        baseline.repositoryRoot,
        ".git",
        "thearchy",
        "worktrees"
      );
      const safePath = assertPathInside(allowedRoot, resolve(path));
      removeWorktree(
        baseline.repositoryRoot,
        safePath,
        optionBoolean(parsed, "force")
      );
      output(`Removed worktree ${safePath}`);
      return;
    }
    default:
      throw new Error(`Unknown workspace command: ${String(command)}`);
  }
}

async function doctor(): Promise<void> {
  const codex = new CodexAdapter();
  const claude = new ClaudeAdapter();
  const baseline = inspectGitBaseline(process.cwd());
  const commands = baseline.repositoryRoot
    ? await detectVerificationCommands(baseline.repositoryRoot)
    : [];
  output(
    {
      version: VERSION,
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      git: baseline,
      hosts: {
        codex: await codex.detect(),
        claude: await claude.detect()
      },
      templates: (await allTemplates()).map((template) => template.metadata.id),
      verificationCommands: commands,
      roles: ALL_ROLES.map((role) => ({
        id: role.id,
        displayName: role.displayName
      }))
    },
    true
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [group, command] = parsed.positionals;
  if (optionBoolean(parsed, "version")) {
    output(VERSION);
    return;
  }
  if (optionBoolean(parsed, "help")) {
    output(usage());
    return;
  }
  switch (group) {
    case undefined:
    case "help":
    case "--help":
      output(usage());
      return;
    case "version":
    case "--version":
      output(VERSION);
      return;
    case "install": {
      const target = optionString(parsed, "target") ?? "all";
      output(
        await installHosts(
          hosts(target),
          optionString(parsed, "output")
            ? resolve(optionString(parsed, "output")!)
            : undefined
        ),
        true
      );
      return;
    }
    case "uninstall":
      await uninstallHosts(hosts(optionString(parsed, "target") ?? "all"));
      output("Thearchy host artifacts were removed.");
      return;
    case "doctor":
      await doctor();
      return;
    case "desktop": {
      if (command === "install") {
        const result = await installHosts(["codex"]);
        const status = await codexDesktopStatus();
        if (!optionBoolean(parsed, "no-launch")) {
          launchExternalUrl(status.deepLink);
        }
        output({ result, status }, true);
        return;
      }
      if (command === "status") {
        output(await codexDesktopStatus(), true);
        return;
      }
      if (command === "uninstall") {
        await uninstallHosts(["codex"]);
        output(await codexDesktopStatus(), true);
        return;
      }
      throw new Error("desktop command must be install, status, or uninstall");
    }
    case "run":
      await handleRun(command, parsed);
      return;
    case "template":
      await handleTemplate(command, parsed);
      return;
    case "workspace":
      await handleWorkspace(command, parsed);
      return;
    case "report": {
      if (command !== "export") throw new Error("Expected report export");
      const id = parsed.positionals[2];
      if (!id) throw new Error("Missing run id");
      const service = coordinator();
      const report = renderRunReport(
        await service.status(id),
        await service.store.events(id)
      );
      const destination = resolve(
        optionString(parsed, "output") ?? join(process.cwd(), `thearchy-${id}.md`)
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, report);
      output(destination);
      return;
    }
    default:
      throw new Error(`Unknown command: ${group}\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`thearchy: ${message}\n`);
  process.exitCode = 1;
});

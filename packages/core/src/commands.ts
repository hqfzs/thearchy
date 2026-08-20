import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DetectedCommand,
  VerificationCapability
} from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pushUnique(
  commands: DetectedCommand[],
  command: DetectedCommand
): void {
  if (
    !commands.some(
      (item) =>
        item.capability === command.capability && item.command === command.command
    )
  ) {
    commands.push(command);
  }
}

export async function detectVerificationCommands(
  repositoryRoot: string
): Promise<DetectedCommand[]> {
  const commands: DetectedCommand[] = [];
  const packageJsonPath = join(repositoryRoot, "package.json");
  if (await exists(packageJsonPath)) {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const mappings: Array<[VerificationCapability, string]> = [
      ["test", "test"],
      ["lint", "lint"],
      ["build", "build"],
      ["typecheck", "typecheck"],
      ["security-scan", "security"]
    ];
    for (const [capability, script] of mappings) {
      if (scripts[script]) {
        pushUnique(commands, {
          capability,
          command: `npm run ${script}`,
          source: "package.json",
          requiresApproval: false
        });
      }
    }
  }

  if (
    (await exists(join(repositoryRoot, "pyproject.toml"))) ||
    (await exists(join(repositoryRoot, "pytest.ini"))) ||
    (await exists(join(repositoryRoot, "tox.ini")))
  ) {
    pushUnique(commands, {
      capability: "test",
      command: "python -m pytest",
      source: "Python project files",
      requiresApproval: false
    });
  }

  if (await exists(join(repositoryRoot, "pyproject.toml"))) {
    const pyproject = await readFile(join(repositoryRoot, "pyproject.toml"), "utf8");
    if (/\b(?:ruff|flake8)\b/i.test(pyproject)) {
      pushUnique(commands, {
        capability: "lint",
        command: "python -m ruff check .",
        source: "pyproject.toml",
        requiresApproval: false
      });
    }
    if (/\b(?:mypy|pyright)\b/i.test(pyproject)) {
      pushUnique(commands, {
        capability: "typecheck",
        command: "python -m mypy .",
        source: "pyproject.toml",
        requiresApproval: false
      });
    }
  }

  return commands;
}

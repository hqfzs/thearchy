import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GitBaseline {
  repositoryRoot?: string;
  commit?: string;
  dirty: boolean;
  available: boolean;
  warning?: string;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function inspectGitBaseline(cwd: string): GitBaseline {
  try {
    const repositoryRoot = git(["rev-parse", "--show-toplevel"], cwd);
    const commit = git(["rev-parse", "HEAD"], repositoryRoot);
    const dirty = git(["status", "--porcelain"], repositoryRoot).length > 0;
    return { repositoryRoot, commit, dirty, available: true };
  } catch (error) {
    return {
      dirty: false,
      available: false,
      warning: error instanceof Error ? error.message : String(error)
    };
  }
}

export interface WorktreeRecord {
  path: string;
  branch: string;
  baselineCommit: string;
}

export async function createWorktree(
  repositoryRoot: string,
  runId: string,
  candidate: string,
  baseDirectory?: string,
  requestedBaselineCommit?: string
): Promise<WorktreeRecord> {
  const baselineCommit =
    requestedBaselineCommit ?? git(["rev-parse", "HEAD"], repositoryRoot);
  git(["cat-file", "-e", `${baselineCommit}^{commit}`], repositoryRoot);
  const branch = `thearchy/${runId}/${candidate}`.replaceAll(/[^A-Za-z0-9/_-]/g, "-");
  const parent = resolve(
    baseDirectory ?? join(repositoryRoot, ".git", "thearchy", "worktrees")
  );
  await mkdir(parent, { recursive: true });
  const path = join(parent, `${runId}-${candidate}`);
  git(["worktree", "add", "-b", branch, path, baselineCommit], repositoryRoot);
  return { path, branch, baselineCommit };
}

export function removeWorktree(
  repositoryRoot: string,
  worktreePath: string,
  force = false
): void {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  git(args, repositoryRoot);
  git(["worktree", "prune"], repositoryRoot);
}

export function listWorktrees(repositoryRoot: string): string[] {
  const output = git(["worktree", "list", "--porcelain"], repositoryRoot);
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

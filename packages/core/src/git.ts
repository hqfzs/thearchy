import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GitBaseline {
  repositoryRoot?: string;
  commit?: string;
  dirty: boolean;
  dirtyFiles: string[];
  available: boolean;
  warning?: string;
}

export function parsePorcelainV1Z(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") {
      throw new Error("Invalid git porcelain v1 -z entry");
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if ((status.includes("R") || status.includes("C")) && fields[index + 1]) {
      paths.push(fields[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(paths)];
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

function gitRaw(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function inspectGitBaseline(cwd: string): GitBaseline {
  try {
    const repositoryRoot = git(["rev-parse", "--show-toplevel"], cwd);
    const commit = git(["rev-parse", "HEAD"], repositoryRoot);
    const status = gitRaw(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      repositoryRoot
    );
    const dirtyFiles = parsePorcelainV1Z(status);
    return {
      repositoryRoot,
      commit,
      dirty: dirtyFiles.length > 0,
      dirtyFiles,
      available: true
    };
  } catch (error) {
    return {
      dirty: false,
      dirtyFiles: [],
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

export interface CandidateDiffSummary {
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface MergeCandidateResult {
  success: boolean;
  conflicted: boolean;
  commit?: string;
  message: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
  const requestedPath = join(parent, `${runId}-${candidate}`);
  git(
    ["worktree", "add", "-b", branch, requestedPath, baselineCommit],
    repositoryRoot
  );
  return { path: canonicalPath(requestedPath), branch, baselineCommit };
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
    .map((line) => canonicalPath(line.slice("worktree ".length)));
}

export function candidateDiffSummary(
  repositoryRoot: string,
  baselineCommit: string,
  branch: string
): CandidateDiffSummary {
  git(["cat-file", "-e", `${baselineCommit}^{commit}`], repositoryRoot);
  git(["cat-file", "-e", `${branch}^{commit}`], repositoryRoot);
  const numstat = git(
    ["diff", "--numstat", `${baselineCommit}..${branch}`],
    repositoryRoot
  );
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const [added, removed, file] = line.split("\t");
    if (file) files.push(file);
    if (added && added !== "-") insertions += Number(added);
    if (removed && removed !== "-") deletions += Number(removed);
  }
  return {
    branch,
    filesChanged: files.length,
    insertions,
    deletions,
    files
  };
}

export function mergeCandidate(
  repositoryRoot: string,
  branch: string
): MergeCandidateResult {
  if (
    gitRaw(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      repositoryRoot
    )
  ) {
    throw new Error("Repository must be clean before candidate integration");
  }
  const result = spawnSync(
    "git",
    ["merge", "--no-ff", "--no-edit", branch],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true
    }
  );
  if (result.status === 0) {
    return {
      success: true,
      conflicted: false,
      commit: git(["rev-parse", "HEAD"], repositoryRoot),
      message: result.stdout.trim() || `Merged ${branch}`
    };
  }
  let conflicts = "";
  try {
    conflicts = git(
      ["diff", "--name-only", "--diff-filter=U"],
      repositoryRoot
    );
  } catch {
    conflicts = "";
  }
  return {
    success: false,
    conflicted: Boolean(conflicts),
    message: result.stderr.trim() || result.stdout.trim() || `Merge failed: ${branch}`
  };
}

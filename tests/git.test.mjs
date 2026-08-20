import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createWorktree,
  inspectGitBaseline,
  listWorktrees,
  removeWorktree
} from "../packages/core/dist/index.js";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function comparablePath(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

test("creates and removes an isolated candidate worktree", async () => {
  const repository = await mkdtemp(join(tmpdir(), "thearchy-git-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "thearchy@example.invalid"]);
  git(repository, ["config", "user.name", "Thearchy Test"]);
  await writeFile(join(repository, "README.md"), "# fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);

  const baseline = inspectGitBaseline(repository);
  assert.equal(baseline.available, true);
  assert.equal(baseline.dirty, false);

  await writeFile(join(repository, "later.txt"), "later\n");
  git(repository, ["add", "later.txt"]);
  git(repository, ["commit", "-m", "later"]);

  const record = await createWorktree(
    repository,
    "run-1",
    "candidate-a",
    undefined,
    baseline.commit
  );
  assert.equal(record.baselineCommit, baseline.commit);
  assert.ok(
    listWorktrees(repository)
      .map(comparablePath)
      .includes(comparablePath(record.path))
  );

  removeWorktree(repository, record.path);
  assert.ok(
    !listWorktrees(repository)
      .map(comparablePath)
      .includes(comparablePath(record.path))
  );
});

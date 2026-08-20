import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  const record = await createWorktree(repository, "run-1", "candidate-a");
  assert.equal(record.baselineCommit, baseline.commit);
  assert.ok(listWorktrees(repository).includes(record.path));

  removeWorktree(repository, record.path);
  assert.ok(!listWorktrees(repository).includes(record.path));
});

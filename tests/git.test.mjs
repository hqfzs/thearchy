import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  candidateDiffSummary,
  createWorktree,
  inspectGitBaseline,
  listWorktrees,
  mergeCandidate,
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
  await access(record.path);
  assert.equal(listWorktrees(repository).length, 2);

  await writeFile(join(record.path, "candidate.txt"), "candidate\n");
  git(record.path, ["add", "candidate.txt"]);
  git(record.path, ["commit", "-m", "candidate"]);
  const summary = candidateDiffSummary(
    repository,
    baseline.commit,
    record.branch
  );
  assert.equal(summary.filesChanged, 1);
  assert.ok(summary.files.includes("candidate.txt"));

  const merged = mergeCandidate(repository, record.branch);
  assert.equal(merged.success, true);
  await access(join(repository, "candidate.txt"));

  removeWorktree(repository, record.path);
  assert.equal(listWorktrees(repository).length, 1);
});

test("reports merge conflicts without resolving or discarding them", async () => {
  const repository = await mkdtemp(join(tmpdir(), "thearchy-conflict-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "thearchy@example.invalid"]);
  git(repository, ["config", "user.name", "Thearchy Test"]);
  await writeFile(join(repository, "shared.txt"), "base\n");
  git(repository, ["add", "shared.txt"]);
  git(repository, ["commit", "-m", "base"]);

  const baseline = inspectGitBaseline(repository);
  const candidate = await createWorktree(
    repository,
    "run-conflict",
    "candidate",
    undefined,
    baseline.commit
  );
  await writeFile(join(candidate.path, "shared.txt"), "candidate\n");
  git(candidate.path, ["add", "shared.txt"]);
  git(candidate.path, ["commit", "-m", "candidate change"]);

  await writeFile(join(repository, "shared.txt"), "main\n");
  git(repository, ["add", "shared.txt"]);
  git(repository, ["commit", "-m", "main change"]);

  const result = mergeCandidate(repository, candidate.branch);
  assert.equal(result.success, false);
  assert.equal(result.conflicted, true);
  git(repository, ["merge", "--abort"]);
  removeWorktree(repository, candidate.path);
});

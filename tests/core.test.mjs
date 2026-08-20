import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Coordinator,
  RunStore,
  assessRisk,
  assertPathInside,
  assertRemoteTemplateFile,
  detectVerificationCommands,
  isSecretPath,
  loadTemplate,
  nextAction
} from "../packages/core/dist/index.js";

const root = resolve(".");

async function artifact(directory, name, content = name) {
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

async function submitAs(
  coordinator,
  snapshot,
  roleId,
  instanceId,
  artifactPath,
  options = {}
) {
  await coordinator.claim(snapshot.id, roleId, instanceId);
  return coordinator.submit({
    runId: snapshot.id,
    roleId,
    instanceId,
    artifactPath,
    ...options
  });
}

test("loads and validates all official template roles", async () => {
  const template = await loadTemplate(join(root, "templates", "feature-delivery.yaml"));
  assert.equal(template.metadata.id, "feature-delivery");
  assert.equal(template.spec.profiles.full.strategy, "competitive");
  assert.ok(template.spec.specialists.includes("expert.builder"));
});

test("risk classifier chooses full mode for high-risk work", () => {
  const assessment = assessRisk(
    "Migrate the production database schema and update authentication permissions",
    "auto"
  );
  assert.equal(assessment.effectiveMode, "full");
  assert.equal(assessment.level, "high");
});

test("security helpers reject escaped and secret paths", () => {
  const base = resolve("sandbox");
  assert.throws(() => assertPathInside(base, resolve("outside")));
  assert.throws(() => assertRemoteTemplateFile("remote/package.json"));
  assert.throws(() => assertRemoteTemplateFile("remote/setup.ps1"));
  assert.equal(isSecretPath("/home/user/.ssh/id_rsa"), true);
  assert.equal(isSecretPath("/repo/src/index.ts"), false);
});

test("detects JavaScript verification commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-commands-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } })
  );
  const commands = await detectVerificationCommands(directory);
  assert.ok(commands.some((command) => command.command === "npm run test"));
  assert.ok(commands.some((command) => command.command === "npm run lint"));
});

test("coordinator enforces the complete governance flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-run-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const template = await loadTemplate(join(root, "templates", "feature-delivery.yaml"));
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Implement a new authentication feature",
    template,
    requestedMode: "full",
    cwd: directory
  });
  assert.equal(nextAction(snapshot).roleId, "governance.router");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.router",
    "router-1",
    await artifact(artifacts, "classification.md")
  );
  assert.equal(snapshot.state, "classified");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-a",
    await artifact(artifacts, "draft-plan.md")
  );
  assert.equal(snapshot.state, "planning");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-b",
    await artifact(artifacts, "final-plan.md")
  );
  assert.equal(snapshot.state, "plan_review");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.judge",
    "judge-plan",
    await artifact(artifacts, "plan-verdict.md")
  );
  assert.equal(snapshot.state, "awaiting_plan_approval");

  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.dispatcher",
    "dispatcher-1",
    await artifact(artifacts, "work-orders.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.builder",
    "builder-1",
    await artifact(artifacts, "implementation.md"),
    { final: true }
  );
  assert.equal(snapshot.state, "verification");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.tester",
    "tester-1",
    await artifact(artifacts, "verification.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.judge",
    "judge-result",
    await artifact(artifacts, "result-verdict.md")
  );
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.publisher",
    "publisher-1",
    await artifact(artifacts, "delivery.md")
  );
  assert.equal(snapshot.state, "completed");

  const events = await coordinator.store.events(snapshot.id);
  assert.ok(events.length >= 10);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1)
  );
  const persisted = JSON.parse(
    await readFile(
      join(directory, "state", "runs", snapshot.id, "snapshot.json"),
      "utf8"
    )
  );
  assert.equal(persisted.state, "completed");
});

test("rejects plans and stops after the configured rework budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-reject-"));
  const template = await loadTemplate(join(root, "templates", "feature-delivery.yaml"));
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Implement feature",
    template,
    requestedMode: "light",
    cwd: directory
  });

  const files = join(directory, "artifacts");
  await mkdir(files);
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.router",
    "router-1",
    await artifact(files, "c.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-a",
    await artifact(files, "p1.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-b",
    await artifact(files, "p2.md")
  );

  for (let count = 0; count < 2; count += 1) {
    snapshot = await coordinator.reject(snapshot.id, "plan", "missing evidence");
    assert.equal(snapshot.state, "rework");
    snapshot = await coordinator.resume(snapshot.id);
    snapshot = await submitAs(
      coordinator,
      snapshot,
      "governance.planner",
      `planner-retry-${count}`,
      await artifact(files, `retry-${count}.md`)
    );
  }
  snapshot = await coordinator.reject(snapshot.id, "plan", "still incomplete");
  assert.equal(snapshot.state, "blocked");
});

async function advanceToExecuting(coordinator, snapshot, directory) {
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.router",
    "router-budget",
    await artifact(directory, "budget-classification.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-budget-a",
    await artifact(directory, "budget-plan-a.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-budget-b",
    await artifact(directory, "budget-plan-b.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.judge",
    "judge-budget",
    await artifact(directory, "budget-plan-verdict.md")
  );
  snapshot = await coordinator.approve(snapshot.id, "plan");
  return submitAs(
    coordinator,
    snapshot,
    "governance.dispatcher",
    "dispatcher-budget",
    await artifact(directory, "budget-work-orders.md")
  );
}

test("enforces template specialists, concurrency, and competing implementation budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-budget-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);

  const codeReview = await loadTemplate(
    join(root, "templates", "code-review.yaml")
  );
  const reviewCoordinator = new Coordinator(
    new RunStore(join(directory, "review-state"))
  );
  let reviewRun = await reviewCoordinator.start({
    task: "Review the current change",
    template: codeReview,
    requestedMode: "full",
    cwd: directory
  });
  reviewRun = await advanceToExecuting(reviewCoordinator, reviewRun, artifacts);
  await assert.rejects(
    reviewCoordinator.claim(reviewRun.id, "expert.builder", "builder-forbidden"),
    /cannot submit/
  );

  const feature = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const budgetCoordinator = new Coordinator(
    new RunStore(join(directory, "budget-state"))
  );
  let budgetRun = await budgetCoordinator.start({
    task: "Implement a large feature",
    template: feature,
    requestedMode: "full",
    cwd: directory,
    budgetOverrides: { maxConcurrency: 2, maxAgents: 4 }
  });
  budgetRun = await advanceToExecuting(budgetCoordinator, budgetRun, artifacts);
  await budgetCoordinator.claim(budgetRun.id, "expert.builder", "builder-1");
  await budgetCoordinator.claim(budgetRun.id, "expert.architect", "architect-1");
  await assert.rejects(
    budgetCoordinator.claim(budgetRun.id, "expert.data", "data-1"),
    /concurrency budget exceeded/
  );
  await budgetCoordinator.release(budgetRun.id, "architect-1");
  await budgetCoordinator.claim(budgetRun.id, "expert.builder", "builder-2");
  await budgetCoordinator.release(budgetRun.id, "builder-2");
  await assert.rejects(
    budgetCoordinator.claim(budgetRun.id, "expert.builder", "builder-3"),
    /Competing implementation budget exceeded/
  );
});

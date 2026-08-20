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

  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.router",
    artifactPath: await artifact(artifacts, "classification.md")
  });
  assert.equal(snapshot.state, "classified");

  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.planner",
    artifactPath: await artifact(artifacts, "draft-plan.md")
  });
  assert.equal(snapshot.state, "planning");

  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.planner",
    artifactPath: await artifact(artifacts, "final-plan.md")
  });
  assert.equal(snapshot.state, "plan_review");

  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.judge",
    artifactPath: await artifact(artifacts, "plan-verdict.md")
  });
  assert.equal(snapshot.state, "awaiting_plan_approval");

  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.dispatcher",
    artifactPath: await artifact(artifacts, "work-orders.md")
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "expert.builder",
    artifactPath: await artifact(artifacts, "implementation.md"),
    final: true
  });
  assert.equal(snapshot.state, "verification");

  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "expert.tester",
    artifactPath: await artifact(artifacts, "verification.md")
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.judge",
    artifactPath: await artifact(artifacts, "result-verdict.md")
  });
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.publisher",
    artifactPath: await artifact(artifacts, "delivery.md")
  });
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
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.router",
    artifactPath: await artifact(files, "c.md")
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.planner",
    artifactPath: await artifact(files, "p1.md")
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.planner",
    artifactPath: await artifact(files, "p2.md")
  });

  for (let count = 0; count < 2; count += 1) {
    snapshot = await coordinator.reject(snapshot.id, "plan", "missing evidence");
    assert.equal(snapshot.state, "rework");
    snapshot = await coordinator.resume(snapshot.id);
    snapshot = await coordinator.submit({
      runId: snapshot.id,
      roleId: "governance.planner",
      artifactPath: await artifact(files, `retry-${count}.md`)
    });
  }
  snapshot = await coordinator.reject(snapshot.id, "plan", "still incomplete");
  assert.equal(snapshot.state, "blocked");
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Coordinator,
  RunStore,
  createHostRuntimeReport,
  loadTemplate,
  validateHostRuntimeReport
} from "../packages/core/dist/index.js";

const root = resolve(".");

async function writeArtifact(directory, name, content = name) {
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

async function advanceLightToExecution(coordinator, snapshot, directory) {
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.router",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "classification.md"),
    rootManaged: true
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.planner",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "plan.md"),
    rootManaged: true
  });
  snapshot = await coordinator.approve(snapshot.id, "plan");
  return coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.dispatcher",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "dispatch.md"),
    rootManaged: true
  });
}

test("runtime capability reports are hashed, validated, and required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-capabilities-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Add a small helper",
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await advanceLightToExecution(coordinator, snapshot, directory);
  await assert.rejects(
    coordinator.claim(
      snapshot.id,
      "expert.builder",
      "builder",
      "gpt-5.6-luna",
      "max"
    ),
    /Runtime capabilities must be registered/
  );

  const report = createHostRuntimeReport({
    subagents: "available",
    parallelAgents: "unknown",
    choicePrompt: "available"
  });
  assert.deepEqual(validateHostRuntimeReport(report), report);
  await assert.rejects(
    coordinator.registerCapabilities(snapshot.id, {
      ...report,
      reportHash: "0".repeat(64)
    }),
    /hash mismatch/
  );
  snapshot = await coordinator.registerCapabilities(snapshot.id, report);
  assert.equal(snapshot.runtimeCapabilities?.reportHash, report.reportHash);
  snapshot = await coordinator.claim(
    snapshot.id,
    "expert.builder",
    "builder",
    "gpt-5.6-luna",
    "max"
  );
  assert.equal(snapshot.activeAgents.length, 1);
});

test("full mode rejects unavailable parallel runtime capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-cap-full-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Implement a large feature",
    template,
    requestedMode: "full",
    cwd: directory
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.router",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "classification.md"),
    rootManaged: true
  });
  await coordinator.registerCapabilities(
    snapshot.id,
    createHostRuntimeReport({
      subagents: "available",
      parallelAgents: "unavailable",
      choicePrompt: "available"
    })
  );
  await assert.rejects(
    coordinator.claim(
      snapshot.id,
      "governance.planner",
      "planner",
      "gpt-5.6-luna",
      "max"
    ),
    /requires parallel agent capability/
  );
});

test("high-risk reassessment pauses light mode for upgrade or cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-escalation-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Add a small helper",
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.router",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "escalation-classification.md"),
    rootManaged: true
  });
  snapshot = await coordinator.reassessRisk({
    runId: snapshot.id,
    signal: "destructive-operation",
    summary: "The task now requires deleting production data"
  });
  assert.equal(snapshot.state, "awaiting_escalation_decision");
  assert.equal(snapshot.risk.level, "high");
  const decision = snapshot.decisions.find(
    (item) => item.kind === "escalation" && item.status === "pending"
  );
  assert.ok(decision);
  snapshot = await coordinator.decide(
    snapshot.id,
    decision.id,
    "upgrade-full"
  );
  assert.equal(snapshot.mode, "full");
  assert.equal(snapshot.state, "planning");
});

test("structured unverified results pause delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-unverified-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Add a small helper",
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await advanceLightToExecution(coordinator, snapshot, directory);
  await coordinator.registerCapabilities(
    snapshot.id,
    createHostRuntimeReport({
      subagents: "available",
      parallelAgents: "unknown",
      choicePrompt: "available"
    })
  );
  await coordinator.claim(
    snapshot.id,
    "expert.builder",
    "builder",
    "gpt-5.6-luna",
    "max"
  );
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "expert.builder",
    instanceId: "builder",
    artifactPath: await writeArtifact(directory, "implementation.md"),
    final: true
  });
  await coordinator.claim(
    snapshot.id,
    "expert.tester",
    "tester",
    "gpt-5.6-luna",
    "max"
  );
  const verificationPath = await writeArtifact(
    directory,
    "verification.json",
    JSON.stringify({
      apiVersion: "thearchy.dev/verification/v1",
      status: "passed",
      attemptStatus: "submitted",
      attempt: 1,
      createdAt: new Date().toISOString(),
      verifierInstanceId: "tester",
      implementerInstanceIds: ["builder"],
      commands: [],
      boundaryChecks: [],
      findings: [],
      reviewedArtifactIds: ["artifact-4"],
      independent: true,
      unverifiedReason: "command-not-executable"
    })
  );
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "expert.tester",
    instanceId: "tester",
    artifactPath: verificationPath
  });
  assert.equal(snapshot.verificationStatus, "unverified");
  assert.equal(snapshot.state, "awaiting_verification_decision");
  assert.equal(
    snapshot.decisions.find((item) => item.status === "pending")?.kind,
    "verification"
  );
});

test("approval waits do not consume active budget and expired runs can be extended", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-active-budget-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const store = new RunStore(join(directory, "state"));
  const coordinator = new Coordinator(store);
  let paused = await coordinator.start({
    task: "Add a small helper",
    template,
    requestedMode: "light",
    cwd: directory
  });
  paused = await coordinator.submit({
    runId: paused.id,
    roleId: "governance.router",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "paused-classification.md"),
    rootManaged: true
  });
  paused = await coordinator.submit({
    runId: paused.id,
    roleId: "governance.planner",
    instanceId: "root-main",
    artifactPath: await writeArtifact(directory, "paused-plan.md"),
    rootManaged: true
  });
  await store.update(paused.id, (snapshot, events) => {
    snapshot.startedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    snapshot.activeElapsedMs = 1_000;
    delete snapshot.activeSince;
    snapshot.pausedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      sequence: events.length + 1,
      runId: snapshot.id,
      type: "run.transitioned",
      timestamp: new Date().toISOString(),
      actor: "test",
      data: { forcedPausedClock: true }
    };
  });
  assert.equal((await coordinator.next(paused.id)).state, "awaiting_plan_approval");

  const expired = await coordinator.start({
    task: "Another small helper",
    template,
    requestedMode: "light",
    cwd: directory,
    allowDuplicate: true
  });
  await store.update(expired.id, (snapshot, events) => {
    snapshot.activeElapsedMs = 11 * 60_000;
    snapshot.activeSince = new Date().toISOString();
    return {
      sequence: events.length + 1,
      runId: snapshot.id,
      type: "run.transitioned",
      timestamp: new Date().toISOString(),
      actor: "test",
      data: { forcedExpiredClock: true }
    };
  });
  await assert.rejects(coordinator.next(expired.id), /exceeded/);
  const extended = await coordinator.extendBudget(expired.id, 5);
  assert.equal(extended.budget.timeoutMinutes, 15);
  assert.equal((await coordinator.next(expired.id)).state, "created");
});

test("capability availability is automatically renewed on claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-cap-renewal-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Add a helper",
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await advanceLightToExecution(coordinator, snapshot, directory);
  await coordinator.registerCapabilities(
    snapshot.id,
    createHostRuntimeReport({
      subagents: "available",
      parallelAgents: "unknown",
      choicePrompt: "available",
      checkedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    })
  );
  const claimed = await coordinator.claim(
    snapshot.id,
    "expert.builder",
    "renewed-builder",
    "gpt-5.6-luna",
    "max"
  );
  assert.ok(
    Date.parse(claimed.runtimeCapabilitiesRegisteredAt) >
      Date.now() - 10_000
  );
});

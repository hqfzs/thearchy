import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Coordinator,
  RunStore,
  assessRisk,
  assertPathInside,
  assertRemoteTemplateFile,
  createHostRuntimeReport,
  detectVerificationCommands,
  inspectRiskContext,
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

async function verificationArtifact(
  directory,
  name,
  snapshot,
  verifierInstanceId,
  status = "passed"
) {
  const implementerInstanceIds = snapshot.agentInstances
    .filter(
      (instance) =>
        instance.roleId.startsWith("expert.") &&
        instance.roleId !== "expert.tester"
    )
    .map((instance) => instance.instanceId);
  const reviewedArtifactIds = snapshot.artifacts
    .filter(
      (item) =>
        item.final ||
        (item.roleId.startsWith("expert.") &&
          item.roleId !== "expert.tester")
    )
    .map((item) => item.id);
  const required = snapshot.requiredVerification;
  return artifact(
    directory,
    name,
    JSON.stringify({
      apiVersion: "thearchy.dev/verification/v1",
      status,
      attemptStatus: "submitted",
      attempt: snapshot.verificationResults.length + 1,
      createdAt: new Date().toISOString(),
      verifierInstanceId,
      implementerInstanceIds,
      commands:
        status === "unverified"
          ? []
          : (required.length > 0 ? required : ["test"]).map((capability) => ({
              capability,
              command: capability === "test" ? "npm test" : `npm run ${capability}`,
              exitCode: status === "failed" ? 1 : 0,
              durationMs: 1
            })),
      boundaryChecks:
        status === "unverified"
          ? []
          : [
              {
                category: "type-confusion",
                input: "coercible or subtype value",
                expected: "explicitly validated",
                observed:
                  status === "failed" ? "boundary failed" : "boundary passed",
                passed: status !== "failed"
              }
            ],
      findings:
        status === "failed"
          ? [{ severity: "high", summary: "verification failed" }]
          : [],
      reviewedArtifactIds,
      independent: true,
      ...(status === "unverified"
        ? { unverifiedReason: "no-verification-command" }
        : {})
    })
  );
}

async function submitAs(
  coordinator,
  snapshot,
  roleId,
  instanceId,
  artifactPath,
  options = {}
) {
  if (!snapshot.runtimeCapabilities) {
    await coordinator.registerCapabilities(
      snapshot.id,
      createHostRuntimeReport({
        subagents: "available",
        parallelAgents: "available",
        choicePrompt: "available"
      })
    );
  }
  await coordinator.claim(
    snapshot.id,
    roleId,
    instanceId,
    "gpt-5.6-luna",
    "max"
  );
  return coordinator.submit({
    runId: snapshot.id,
    roleId,
    instanceId,
    artifactPath,
    ...options
  });
}

async function submitRoot(
  coordinator,
  snapshot,
  roleId,
  artifactPath,
  options = {}
) {
  return coordinator.submit({
    runId: snapshot.id,
    roleId,
    instanceId: "root-main",
    artifactPath,
    rootManaged: true,
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
  assert.equal(assessment.routing, "forced-full");
  assert.equal(assessment.requiresModeApproval, false);

  const forced = assessRisk(
    "Delete production database credentials",
    "light"
  );
  assert.equal(forced.effectiveMode, "full");
  assert.equal(forced.routing, "forced-full");
});

test("risk classifier incorporates repository and verification context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-risk-context-"));
  await mkdir(join(directory, "tests"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } })
  );
  const cleanContext = inspectRiskContext(directory, "feature-delivery", {
    available: false,
    dirty: false,
    dirtyFiles: []
  });
  assert.deepEqual(cleanContext.projectKinds, ["javascript-typescript"]);
  assert.equal(cleanContext.hasVerification, true);
  assert.equal(
    assessRisk("Update a formatting helper", "auto", cleanContext).routing,
    "automatic-light"
  );

  const changedContext = inspectRiskContext(directory, "feature-delivery", {
    available: true,
    dirty: true,
    dirtyFiles: [
      "src/auth/session.ts",
      "src/ui.ts",
      "tests/auth.test.ts",
      "package.json"
    ]
  });
  const contextual = assessRisk(
    "Update a formatting helper",
    "auto",
    changedContext
  );
  assert.equal(contextual.level, "medium");
  assert.equal(contextual.routing, "confirm");
  assert.ok(contextual.reasons.includes("sensitive paths already modified"));
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

test("detects a Python standard-library test fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-python-commands-"));
  await mkdir(join(directory, "tests"));
  await writeFile(join(directory, "pyproject.toml"), "[project]\nname='fixture'\n");
  const commands = await detectVerificationCommands(directory);
  assert.ok(
    commands.some(
      (command) => command.command === "python -m unittest discover -s tests"
    )
  );
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

  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.router",
    await artifact(artifacts, "classification.md")
  );
  assert.equal(snapshot.state, "classified");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.planner",
    "planner-1",
    await artifact(artifacts, "final-plan.md")
  );
  assert.equal(snapshot.state, "plan_review");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.judge",
    "judge-1",
    await artifact(artifacts, "plan-verdict.md")
  );
  assert.equal(snapshot.state, "awaiting_plan_approval");

  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.dispatcher",
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
  const verificationAction = await coordinator.next(snapshot.id);
  assert.deepEqual(verificationAction.parallelRoles, [
    "expert.tester",
    "governance.judge"
  ]);

  await coordinator.claim(
    snapshot.id,
    "expert.tester",
    "tester-1",
    "gpt-5.6-luna",
    "max"
  );
  await coordinator.claim(
    snapshot.id,
    "governance.judge",
    "judge-1",
    "gpt-5.6-luna",
    "max"
  );
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "governance.judge",
    instanceId: "judge-1",
    artifactPath: await artifact(artifacts, "result-verdict.md")
  });
  assert.equal(snapshot.state, "verification");
  snapshot = await coordinator.submit({
    runId: snapshot.id,
    roleId: "expert.tester",
    instanceId: "tester-1",
    artifactPath: await verificationArtifact(
      artifacts,
      "verification.json",
      snapshot,
      "tester-1"
    )
  });
  assert.equal(snapshot.state, "awaiting_merge_approval");
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.publisher",
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
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.router",
    await artifact(files, "c.md")
  );
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.planner",
    await artifact(files, "p2.md")
  );

  for (let count = 0; count < snapshot.budget.maxPlanReworks; count += 1) {
    snapshot = await coordinator.reject(snapshot.id, "plan", "missing evidence");
    assert.equal(snapshot.state, "rework");
    snapshot = await coordinator.resume(snapshot.id);
    snapshot = await submitRoot(
      coordinator,
      snapshot,
      "governance.planner",
      await artifact(files, `retry-${count}.md`)
    );
  }
  snapshot = await coordinator.reject(snapshot.id, "plan", "still incomplete");
  assert.equal(snapshot.state, "awaiting_conflict_decision");
  assert.equal(
    snapshot.decisions.find((decision) => decision.status === "pending")?.kind,
    "conflict"
  );
});

async function advanceToExecuting(coordinator, snapshot, directory) {
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.router",
    await artifact(directory, "budget-classification.md")
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
  return submitRoot(
    coordinator,
    snapshot,
    "governance.dispatcher",
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
    reviewCoordinator.claim(
      reviewRun.id,
      "expert.builder",
      "builder-forbidden",
      "gpt-5.6-luna",
      "max"
    ),
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
    budgetOverrides: {
      maxConcurrency: 2,
      maxAgents: 6,
      maxCompetingImplementations: 2
    }
  });
  budgetRun = await advanceToExecuting(budgetCoordinator, budgetRun, artifacts);
  await budgetCoordinator.claim(
    budgetRun.id,
    "expert.builder",
    "builder-1",
    "gpt-5.6-luna",
    "max"
  );
  await budgetCoordinator.claim(
    budgetRun.id,
    "expert.architect",
    "architect-1",
    "gpt-5.6-luna",
    "max"
  );
  await assert.rejects(
    budgetCoordinator.claim(
      budgetRun.id,
      "expert.data",
      "data-1",
      "gpt-5.6-luna",
      "max"
    ),
    /concurrency budget exceeded/
  );
  await budgetCoordinator.release(budgetRun.id, "architect-1");
  await budgetCoordinator.claim(
    budgetRun.id,
    "expert.builder",
    "builder-2",
    "gpt-5.6-luna",
    "max"
  );
  await budgetCoordinator.release(budgetRun.id, "builder-2");
  await assert.rejects(
    budgetCoordinator.claim(
      budgetRun.id,
      "expert.builder",
      "builder-3",
      "gpt-5.6-luna",
      "max"
    ),
    /Competing implementation budget exceeded/
  );
});

test("auto mode only asks for medium risk and safely routes low and high risk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-mode-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let mediumRun = await coordinator.start({
    task: "Implement authentication support",
    template,
    requestedMode: "auto",
    cwd: directory
  });
  mediumRun = await submitRoot(
    coordinator,
    mediumRun,
    "governance.router",
    await artifact(artifacts, "medium-classification.md")
  );
  assert.equal(mediumRun.state, "awaiting_mode_approval");
  const action = await coordinator.next(mediumRun.id);
  assert.equal(action.interaction?.kind, "mode");
  const modeDecision = action.interaction;
  assert.ok(modeDecision);
  mediumRun = await coordinator.decide(
    mediumRun.id,
    modeDecision.id,
    "full"
  );
  assert.equal(mediumRun.state, "classified");
  assert.equal(mediumRun.mode, "full");

  let lowRun = await coordinator.start({
    task: "Small documentation change",
    template,
    requestedMode: "auto",
    cwd: directory,
    allowDuplicate: true
  });
  lowRun = await submitRoot(
    coordinator,
    lowRun,
    "governance.router",
    await artifact(artifacts, "low-classification.md")
  );
  assert.equal(lowRun.state, "classified");
  assert.equal(lowRun.mode, "light");
  assert.equal(lowRun.risk.routing, "automatic-light");
  assert.equal(
    lowRun.decisions.some((decision) => decision.kind === "mode"),
    false
  );

  let highRun = await coordinator.start({
    task: "Delete production database credentials",
    template,
    requestedMode: "auto",
    cwd: directory,
    allowDuplicate: true
  });
  highRun = await submitRoot(
    coordinator,
    highRun,
    "governance.router",
    await artifact(artifacts, "high-classification.md")
  );
  assert.equal(highRun.state, "classified");
  assert.equal(highRun.mode, "full");
  assert.equal(highRun.risk.routing, "forced-full");
  assert.equal(
    highRun.decisions.some((decision) => decision.kind === "mode"),
    false
  );

  const explicitHigh = await coordinator.start({
    task: "Delete production database credentials",
    template,
    requestedMode: "light",
    cwd: directory,
    allowDuplicate: true
  });
  assert.equal(explicitHigh.mode, "full");
  assert.equal(explicitHigh.risk.routing, "forced-full");
});

test("light mode uses one expert and one independent combined verifier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-light-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Add a small formatting helper",
    template,
    requestedMode: "auto",
    cwd: directory
  });
  assert.equal(snapshot.mode, "light");
  assert.equal(snapshot.budget.maxAgents, 2);
  assert.equal(snapshot.budget.maxConcurrency, 1);

  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.router",
    await artifact(artifacts, "light-classification.md")
  );
  assert.equal(snapshot.state, "classified");
  assert.equal((await coordinator.next(snapshot.id)).modelPolicy, undefined);

  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.planner",
    await artifact(artifacts, "light-plan.md")
  );
  assert.equal(snapshot.state, "awaiting_plan_approval");
  assert.equal(
    snapshot.decisions.find((decision) => decision.kind === "plan")?.context
      .independentlyReviewed,
    false
  );

  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submitRoot(
    coordinator,
    snapshot,
    "governance.dispatcher",
    await artifact(artifacts, "light-dispatch.md")
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.builder",
    "light-builder",
    await artifact(artifacts, "light-implementation.md"),
    { final: true }
  );
  const verification = await coordinator.next(snapshot.id);
  assert.equal(verification.action, "verify-and-review");
  assert.equal(verification.roleId, "expert.tester");
  assert.equal(verification.parallelRoles, undefined);
  await assert.rejects(
    coordinator.claim(
      snapshot.id,
      "governance.judge",
      "light-judge",
      "gpt-5.6-luna",
      "max"
    ),
    /cannot submit/
  );

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.tester",
    "light-verifier",
    await verificationArtifact(
      artifacts,
      "light-verification.json",
      snapshot,
      "light-verifier"
    )
  );
  assert.equal(snapshot.state, "awaiting_merge_approval");
  assert.equal(snapshot.verificationCompleted, true);
  assert.equal(snapshot.resultReviewCompleted, true);
  assert.equal(snapshot.agentInstances.length, 2);
});

test("requires Luna max and recovers expired leases through an inquiry decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-lease-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const store = new RunStore(join(directory, "state"));
  const coordinator = new Coordinator(store);
  const snapshot = await coordinator.start({
    task: "Implement feature",
    template,
    requestedMode: "full",
    cwd: directory
  });
  await coordinator.registerCapabilities(
    snapshot.id,
    createHostRuntimeReport({
      subagents: "available",
      parallelAgents: "available",
      choicePrompt: "available"
    })
  );
  await assert.rejects(
    coordinator.claim(
      snapshot.id,
      "governance.router",
      "router-medium",
      "gpt-5.6-luna",
      "medium"
    ),
    /must use gpt-5.6-luna with max reasoning/
  );
  await coordinator.claim(
    snapshot.id,
    "governance.router",
    "router-stale",
    "gpt-5.6-luna",
    "max"
  );
  await store.update(snapshot.id, (current, events) => {
    current.activeAgents[0].expiresAt = new Date(0).toISOString();
    return {
      sequence: events.length + 1,
      runId: snapshot.id,
      type: "agent.heartbeat",
      timestamp: new Date().toISOString(),
      actor: "test",
      data: { forcedExpired: true }
    };
  });
  const action = await coordinator.next(snapshot.id);
  assert.equal(action.state, "awaiting_conflict_decision");
  assert.equal(action.interaction?.kind, "conflict");
  const recovered = await coordinator.status(snapshot.id);
  assert.equal(recovered.activeAgents.length, 0);
  assert.ok(
    (await store.events(snapshot.id)).some(
      (event) => event.type === "agent.expired"
    )
  );
});

test("gates high-risk operations behind a decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-risk-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Implement feature",
    template,
    requestedMode: "full",
    cwd: directory
  });
  snapshot = await advanceToExecuting(coordinator, snapshot, artifacts);
  snapshot = await coordinator.requestOperation({
    runId: snapshot.id,
    type: "dependency-install",
    summary: "Install a new authentication dependency"
  });
  assert.equal(snapshot.state, "awaiting_risk_approval");
  const decision = snapshot.decisions.find(
    (item) => item.kind === "risk" && item.status === "pending"
  );
  assert.ok(decision);
  await assert.rejects(
    coordinator.claim(
      snapshot.id,
      "expert.builder",
      "blocked-builder",
      "gpt-5.6-luna",
      "max"
    ),
    /cannot submit/
  );
  snapshot = await coordinator.decide(snapshot.id, decision.id, "deny");
  assert.equal(snapshot.state, "executing");
  assert.equal(snapshot.pendingOperation, undefined);
});

test("migrates v1 snapshots and preserves the original backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-migrate-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const store = new RunStore(join(directory, "state"));
  const coordinator = new Coordinator(store);
  const created = await coordinator.start({
    task: "Migration fixture",
    template,
    requestedMode: "light",
    cwd: directory
  });
  const snapshotPath = join(
    directory,
    "state",
    "runs",
    created.id,
    "snapshot.json"
  );
  const legacy = JSON.parse(await readFile(snapshotPath, "utf8"));
  legacy.schemaVersion = 1;
  delete legacy.modelPolicy;
  delete legacy.decisions;
  delete legacy.candidates;
  delete legacy.modeBudgets;
  delete legacy.templatePermissions;
  await writeFile(snapshotPath, JSON.stringify(legacy, null, 2));

  const migrated = await store.load(created.id);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.modelPolicy.model, "gpt-5.6-luna");
  assert.deepEqual(migrated.decisions, []);
  await access(
    join(
      directory,
      "state",
      "runs",
      created.id,
      "snapshot.schema-1.backup.json"
    )
  );
});

test("reuses an active matching run instead of creating a duplicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-deduplicate-"));
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const store = new RunStore(join(directory, "state"));
  const coordinator = new Coordinator(store);
  const first = await coordinator.start({
    task: "Implement the same feature",
    template,
    requestedMode: "full",
    cwd: directory
  });
  const resumed = await coordinator.start({
    task: "  implement   the same FEATURE ",
    template,
    requestedMode: "full",
    cwd: directory
  });
  assert.equal(resumed.id, first.id);
  assert.ok(
    (await store.events(first.id)).some(
      (event) =>
        event.type === "run.resumed" &&
        event.data.reason === "duplicate-start-prevented"
    )
  );
  const duplicate = await coordinator.start({
    task: "Implement the same feature",
    template,
    requestedMode: "full",
    cwd: directory,
    allowDuplicate: true
  });
  assert.notEqual(duplicate.id, first.id);
});

test("persists, verifies, selects, and integrates workspace candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thearchy-candidate-"));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const template = await loadTemplate(
    join(root, "templates", "feature-delivery.yaml")
  );
  const coordinator = new Coordinator(new RunStore(join(directory, "state")));
  let snapshot = await coordinator.start({
    task: "Implement candidate feature",
    template,
    requestedMode: "full",
    cwd: root
  });
  snapshot = await advanceToExecuting(coordinator, snapshot, artifacts);
  assert.ok(snapshot.baselineCommit);
  snapshot = await coordinator.registerCandidate(snapshot.id, {
    id: "candidate-a",
    branch: "thearchy/test/candidate-a",
    path: join(directory, "candidate-a"),
    baselineCommit: snapshot.baselineCommit
  });
  const verification = await artifact(
    artifacts,
    "candidate-verification.md",
    "all tests passed"
  );
  snapshot = await coordinator.verifyCandidate(
    snapshot.id,
    "candidate-a",
    verification
  );
  assert.equal(snapshot.candidates[0].status, "verified");

  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.builder",
    "candidate-builder",
    await artifact(artifacts, "candidate-implementation.md"),
    { final: true }
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "expert.tester",
    "candidate-tester",
    await verificationArtifact(
      artifacts,
      "candidate-tests.json",
      snapshot,
      "candidate-tester"
    )
  );
  snapshot = await submitAs(
    coordinator,
    snapshot,
    "governance.judge",
    "judge-budget",
    await artifact(artifacts, "candidate-judgment.md")
  );
  const decision = snapshot.decisions.find(
    (item) => item.kind === "merge" && item.status === "pending"
  );
  assert.ok(decision);
  snapshot = await coordinator.decide(
    snapshot.id,
    decision.id,
    "candidate:candidate-a"
  );
  assert.equal(snapshot.state, "integrating");
  assert.equal(snapshot.selectedCandidateId, "candidate-a");
  snapshot = await coordinator.markCandidateIntegrated(
    snapshot.id,
    "candidate-a",
    "deadbeef"
  );
  assert.equal(snapshot.candidates[0].status, "selected");
});

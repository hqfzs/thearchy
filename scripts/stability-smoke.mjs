import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  Coordinator,
  RunStore,
  createHostRuntimeReport,
  loadTemplate
} from "../packages/core/dist/index.js";

const root = resolve(".");
const template = await loadTemplate(
  join(root, "templates", "feature-delivery.yaml")
);
const directory = await mkdtemp(join(tmpdir(), "thearchy-stability-"));
const store = new RunStore(join(directory, "state"));
const coordinator = new Coordinator(store);

async function artifact(runId, name) {
  const path = join(directory, runId, name);
  await mkdir(join(directory, runId), { recursive: true });
  await writeFile(path, `${runId}:${name}\n`);
  return path;
}

async function verificationArtifact(snapshot, instanceId) {
  const path = join(directory, snapshot.id, "verification.json");
  const implementerInstanceIds = snapshot.agentInstances
    .filter(
      (instance) =>
        instance.roleId.startsWith("expert.") &&
        instance.roleId !== "expert.tester"
    )
    .map((instance) => instance.instanceId);
  const reviewedArtifactIds = snapshot.artifacts
    .filter((item) => item.final)
    .map((item) => item.id);
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "thearchy.dev/verification/v1",
      status: "passed",
      attemptStatus: "submitted",
      attempt: snapshot.verificationResults.length + 1,
      createdAt: new Date().toISOString(),
      verifierInstanceId: instanceId,
      implementerInstanceIds,
      commands: snapshot.requiredVerification.map((capability) => ({
        capability,
        command: capability === "test" ? "npm test" : `npm run ${capability}`,
        exitCode: 0,
        durationMs: 1
      })),
      findings: [],
      reviewedArtifactIds,
      independent: true
    })
  );
  return path;
}

async function submit(snapshot, roleId, instanceId, name, options = {}) {
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
    artifactPath: isAbsolute(name) ? name : await artifact(snapshot.id, name),
    ...options
  });
}

async function submitRoot(snapshot, roleId, name, options = {}) {
  return coordinator.submit({
    runId: snapshot.id,
    roleId,
    instanceId: "root-main",
    artifactPath: await artifact(snapshot.id, name),
    rootManaged: true,
    ...options
  });
}

async function completeRun(mode, index) {
  let snapshot = await coordinator.start({
    task: `${mode} stability run ${index + 1}`,
    template,
    requestedMode: mode,
    cwd: directory
  });
  snapshot = await submitRoot(snapshot, "governance.router", "classification.md");
  snapshot =
    mode === "light"
      ? await submitRoot(snapshot, "governance.planner", "plan.md")
      : await submit(
          snapshot,
          "governance.planner",
          "planner",
          "plan.md"
        );
  if (mode === "full") {
    snapshot = await submit(
      snapshot,
      "governance.judge",
      "judge",
      "plan-review.md"
    );
  }
  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submitRoot(snapshot, "governance.dispatcher", "work-orders.md");
  snapshot = await submit(
    snapshot,
    "expert.builder",
    "builder",
    "implementation.md",
    { final: true }
  );
  if (mode === "full") {
    await coordinator.claim(
      snapshot.id,
      "expert.tester",
      "tester",
      "gpt-5.6-luna",
      "max"
    );
    await coordinator.claim(
      snapshot.id,
      "governance.judge",
      "judge",
      "gpt-5.6-luna",
      "max"
    );
    snapshot = await coordinator.submit({
      runId: snapshot.id,
      roleId: "governance.judge",
      instanceId: "judge",
      artifactPath: await artifact(snapshot.id, "result-review.md")
    });
    snapshot = await coordinator.submit({
      runId: snapshot.id,
      roleId: "expert.tester",
      instanceId: "tester",
      artifactPath: await verificationArtifact(snapshot, "tester")
    });
  } else {
    snapshot = await submit(
      snapshot,
      "expert.tester",
      "tester",
      await verificationArtifact(snapshot, "tester")
    );
  }
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await submitRoot(snapshot, "governance.publisher", "delivery.md");
  if (snapshot.state !== "completed") {
    throw new Error(`${mode} run ${index + 1} ended in ${snapshot.state}`);
  }
  const expectedAgents = mode === "light" ? 2 : 4;
  if (snapshot.agentInstances.length !== expectedAgents) {
    throw new Error(
      `${mode} run ${index + 1} used ${snapshot.agentInstances.length} child agents`
    );
  }
}

for (const mode of ["light", "full"]) {
  for (let index = 0; index < 20; index += 1) {
    await completeRun(mode, index);
  }
}

process.stdout.write(
  "Stability smoke passed: 20 light and 20 full runs completed without state damage.\n"
);

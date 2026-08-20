import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Coordinator,
  RunStore,
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

async function submit(snapshot, roleId, instanceId, name, options = {}) {
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
    artifactPath: await artifact(snapshot.id, name),
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

for (let index = 0; index < 20; index += 1) {
  let snapshot = await coordinator.start({
    task: `Stability run ${index + 1}`,
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await submitRoot(
    snapshot,
    "governance.router",
    "classification.md"
  );
  snapshot = await submitRoot(
    snapshot,
    "governance.planner",
    "plan-b.md"
  );
  snapshot = await submit(
    snapshot,
    "governance.judge",
    `judge-${index}`,
    "plan-verdict.md"
  );
  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submitRoot(
    snapshot,
    "governance.dispatcher",
    "work-orders.md"
  );
  snapshot = await submit(
    snapshot,
    "expert.builder",
    `builder-${index}`,
    "implementation.md",
    { final: true }
  );
  snapshot = await submit(
    snapshot,
    "expert.tester",
    `tester-${index}`,
    "verification.md"
  );
  snapshot = await submit(
    snapshot,
    "governance.judge",
    `judge-${index}`,
    "result-verdict.md"
  );
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await submitRoot(
    snapshot,
    "governance.publisher",
    "delivery.md"
  );
  if (snapshot.state !== "completed") {
    throw new Error(`Stability run ${index + 1} ended in ${snapshot.state}`);
  }
}

process.stdout.write("Stability smoke passed: 20 consecutive completed runs.\n");

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

for (let index = 0; index < 20; index += 1) {
  let snapshot = await coordinator.start({
    task: `Stability run ${index + 1}`,
    template,
    requestedMode: "light",
    cwd: directory
  });
  snapshot = await submit(
    snapshot,
    "governance.router",
    `router-${index}`,
    "classification.md"
  );
  snapshot = await submit(
    snapshot,
    "governance.planner",
    `planner-a-${index}`,
    "plan-a.md"
  );
  snapshot = await submit(
    snapshot,
    "governance.planner",
    `planner-b-${index}`,
    "plan-b.md"
  );
  snapshot = await submit(
    snapshot,
    "governance.judge",
    `judge-plan-${index}`,
    "plan-verdict.md"
  );
  snapshot = await coordinator.approve(snapshot.id, "plan");
  snapshot = await submit(
    snapshot,
    "governance.dispatcher",
    `dispatcher-${index}`,
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
    `judge-result-${index}`,
    "result-verdict.md"
  );
  snapshot = await coordinator.approve(snapshot.id, "merge");
  snapshot = await submit(
    snapshot,
    "governance.publisher",
    `publisher-${index}`,
    "delivery.md"
  );
  if (snapshot.state !== "completed") {
    throw new Error(`Stability run ${index + 1} ended in ${snapshot.state}`);
  }
}

process.stdout.write("Stability smoke passed: 20 consecutive completed runs.\n");

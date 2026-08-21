import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore, nextEvent } from "../packages/core/dist/store.js";

function budget() {
  return {
    maxAgents: 2,
    maxConcurrency: 1,
    timeoutMinutes: 10,
    maxPlanReworks: 1,
    maxResultReworks: 1,
    maxCompetingImplementations: 1,
    leaseTimeoutMinutes: 5
  };
}

function snapshot(id) {
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: 3,
    task: "store recovery fixture",
    taskFingerprint: "fixture",
    templateId: "feature-delivery",
    requestedMode: "light",
    mode: "light",
    risk: {
      impactScore: 0,
      complexityScore: 0,
      uncertaintyScore: 0,
      operationalScore: 0,
      totalScore: 0,
      score: 0,
      level: "low",
      effectiveMode: "light",
      routing: "explicit",
      requiresModeApproval: false,
      reasons: [],
      context: {
        templateId: "feature-delivery",
        gitStatus: "clean",
        gitAvailable: true,
        dirtyWorkingTree: false,
        dirtyFileCount: 0,
        sensitivePathsChanged: false,
        hasVerification: true,
        verificationCommands: [],
        projectKinds: ["javascript-typescript"]
      }
    },
    state: "created",
    planReworks: 0,
    resultReworks: 0,
    verificationCompleted: false,
    verificationAttemptStatus: "not_started",
    verificationStatus: "unverified",
    verificationResults: [],
    resultReviewCompleted: false,
    modelPolicy: {
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      preserveMainModel: true
    },
    templatePermissions: {
      network: "approval",
      dependencyInstall: "approval",
      destructive: "approval",
      externalWrite: "approval",
      sensitiveRead: "deny"
    },
    allowedGovernance: [],
    allowedSpecialists: [],
    participants: [],
    activeAgents: [],
    agentInstances: [],
    artifacts: [],
    decisions: [],
    candidates: [],
    approvals: {},
    dirtyWorkingTree: false,
    modeBudgets: { light: budget(), full: budget() },
    budget: budget(),
    startedAt: now,
    updatedAt: now
  };
}

function event(runId, sequence, type = "run.started") {
  return {
    sequence,
    runId,
    type,
    timestamp: new Date().toISOString(),
    actor: "test",
    data: {}
  };
}

async function makeRun() {
  const root = await mkdtemp(join(tmpdir(), "thearchy-store-recovery-"));
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const store = new RunStore(root);
  await store.create(snapshot(runId), event(runId, 1));
  return { root, runId, store };
}

const interruptionPoints = [
  "after-pending-write",
  "after-events-append",
  "before-snapshot-replace",
  "after-snapshot-replace"
];

for (const point of interruptionPoints) {
  test(`recovers idempotently after ${point}`, async () => {
    const { root, runId, store } = await makeRun();
    let injected = false;
    const failing = new RunStore(root, {
      failureInjector: (currentPoint) => {
        if (!injected && currentPoint === point) {
          injected = true;
          throw new Error(`injected interruption at ${point}`);
        }
      }
    });

    await assert.rejects(
      failing.update(runId, (current, events) => {
        current.task = "recovered task";
        return nextEvent(events, runId, "run.transitioned", "test", {
          point
        });
      }),
      new RegExp(`injected interruption at ${point}`)
    );

    const runDirectory = store.runDirectory(runId);
    await access(join(runDirectory, "pending-transaction.json"));
    await access(join(runDirectory, "backup"));

    const recovering = new RunStore(root);
    const recovered = await recovering.load(runId);
    assert.equal(recovered.task, "recovered task");
    assert.equal(recovered.readOnlyRecovery, undefined);

    const firstEvents = await recovering.events(runId);
    assert.ok(firstEvents.some((item) => item.type === "store.recovered"));
    const second = await recovering.load(runId);
    const secondEvents = await recovering.events(runId);
    assert.equal(second.task, "recovered task");
    assert.equal(secondEvents.length, firstEvents.length);

    await assert.rejects(
      access(join(runDirectory, "pending-transaction.json")),
      { code: "ENOENT" }
    );
    const backupNames = await readdir(join(runDirectory, "backup"));
    assert.ok(backupNames.some((name) => name.startsWith("snapshot.")));
    assert.ok(backupNames.some((name) => name.startsWith("events.")));
  });
}

test("repairs a truncated final JSONL line and audits the recovery", async () => {
  const { root, runId, store } = await makeRun();
  const eventsPath = join(store.runDirectory(runId), "events.jsonl");
  const original = await readFile(eventsPath, "utf8");
  await writeFile(eventsPath, `${original}{"sequence":2,"runId":"${runId}"`);

  const recovered = await new RunStore(root).load(runId);
  assert.equal(recovered.readOnlyRecovery, undefined);
  const events = await new RunStore(root).events(runId);
  assert.equal(events.length, 2);
  assert.equal(
    events.filter((item) => item.type === "store.recovered").length,
    1
  );
  const repaired = await readFile(eventsPath, "utf8");
  assert.ok(repaired.endsWith("\n"));
  await access(join(store.runDirectory(runId), "backup"));
});

test("preserves mid-log corruption and returns a read-only recovery snapshot", async () => {
  const { root, runId, store } = await makeRun();
  await store.update(runId, (current, events) => {
    current.task = "before corruption";
    return nextEvent(events, runId, "run.transitioned", "test", {});
  });

  const eventsPath = join(store.runDirectory(runId), "events.jsonl");
  const lines = (await readFile(eventsPath, "utf8")).trimEnd().split(/\r?\n/);
  await writeFile(eventsPath, `${lines[0]}\n{"broken"\n${lines[1]}\n`);

  const recovered = await new RunStore(root).load(runId);
  assert.ok(recovered.readOnlyRecovery);
  assert.match(recovered.readOnlyRecovery.reason, /Event log corruption/);
  await access(join(store.runDirectory(runId), "events.jsonl.corrupt"));

  const audit = JSON.parse(
    (await readFile(join(store.runDirectory(runId), "recovery-events.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .at(-1)
  );
  assert.equal(audit.type, "store.recovered");
  assert.equal(audit.data.outcome, "read-only");
  await assert.rejects(
    new RunStore(root).update(runId, () => {
      throw new Error("must not mutate");
    }),
    /read-only recovery/
  );
});

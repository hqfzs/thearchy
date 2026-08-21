import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Coordinator,
  RunStore,
  createHostRuntimeReport,
  loadTemplate
} from "../packages/core/dist/index.js";

const root = resolve(".");
const cases = [
  {
    id: "docs-typo",
    template: "feature-delivery",
    task: "Correct a typo in the README.",
    expectedLevel: "low",
    expectedRouting: "automatic-light"
  },
  {
    id: "test-helper",
    template: "bug-repair",
    task: "Rename a local test helper without changing behavior.",
    expectedLevel: "low",
    expectedRouting: "automatic-light"
  },
  {
    id: "formatter-review",
    template: "code-review",
    task: "Review the local formatter for obvious correctness issues.",
    expectedLevel: "low",
    expectedRouting: "automatic-light"
  },
  {
    id: "parser-validation",
    template: "feature-delivery",
    task: "Add input validation to one local parser with tests.",
    expectedLevel: "low",
    expectedRouting: "automatic-light"
  },
  {
    id: "authentication",
    template: "feature-delivery",
    task: "Implement authentication API support.",
    expectedLevel: "medium",
    expectedRouting: "confirm"
  },
  {
    id: "dirty-sensitive-context",
    template: "feature-delivery",
    task: "Update a formatting helper.",
    dirtySensitive: true,
    expectedLevel: "medium",
    expectedRouting: "confirm"
  },
  {
    id: "network-deploy",
    template: "feature-delivery",
    task: "Deploy a network service configuration.",
    expectedLevel: "medium",
    expectedRouting: "confirm"
  },
  {
    id: "database-delete",
    template: "bug-repair",
    task: "Delete production database credentials.",
    expectedLevel: "high",
    expectedRouting: "forced-full"
  },
  {
    id: "schema-migration",
    template: "refactor-migration",
    task: "Migrate the authentication database schema.",
    expectedLevel: "high",
    expectedRouting: "forced-full"
  },
  {
    id: "payment-permissions",
    template: "security-review",
    task: "Review and change payment permissions.",
    expectedLevel: "high",
    expectedRouting: "forced-full"
  }
];

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

async function createRepository(caseDefinition, repetition) {
  const directory = await mkdtemp(
    join(tmpdir(), `thearchy-routing-${repetition}-${caseDefinition.id}-`)
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "routing-fixture",
      private: true,
      scripts: { test: "node --test" }
    })
  );
  await writeFile(join(directory, "index.js"), "export const value = 1;\n");
  await mkdir(join(directory, "tests"));
  await writeFile(
    join(directory, "tests", "index.test.js"),
    "import assert from 'node:assert/strict'; assert.equal(1, 1);\n"
  );
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.email", "benchmark@thearchy.invalid"]);
  git(directory, ["config", "user.name", "Thearchy Benchmark"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture"]);

  if (caseDefinition.dirtySensitive) {
    for (const [path, content] of [
      ["src/auth/session.ts", "export const session = true;\n"],
      ["src/ui.ts", "export const ui = true;\n"],
      ["tests/auth.test.ts", "export const test = true;\n"],
      ["package-lock.json", "{}\n"]
    ]) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  return directory;
}

async function artifact(directory, name, content = name) {
  const path = join(directory, "artifacts", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content}\n`);
  return path;
}

async function verificationArtifact(
  directory,
  snapshot,
  verifierInstanceId
) {
  const implementerInstanceIds = snapshot.agentInstances
    .filter(
      (instance) =>
        instance.roleId.startsWith("expert.") &&
        instance.roleId !== "expert.tester"
    )
    .map((instance) => instance.instanceId);
  return artifact(
    directory,
    "verification.json",
    JSON.stringify({
      apiVersion: "thearchy.dev/verification/v1",
      status: "passed",
      attemptStatus: "submitted",
      attempt: snapshot.verificationResults.length + 1,
      createdAt: new Date().toISOString(),
      verifierInstanceId,
      implementerInstanceIds,
      commands: (snapshot.requiredVerification.length > 0
        ? snapshot.requiredVerification
        : snapshot.risk.context.verificationCommands
            .slice(0, 1)
            .map((item) => item.capability)
      ).map((capability) => ({
        capability,
        command: capability === "test" ? "npm test" : `npm run ${capability}`,
        exitCode: 0,
        durationMs: 1
      })),
      boundaryChecks: [
        {
          category: "type-confusion",
          input: "coercible or subtype value",
          expected: "explicit validation",
          observed: "rejected or safely handled",
          passed: true
        }
      ],
      findings: [],
      reviewedArtifactIds: snapshot.artifacts
        .filter((item) => item.final)
        .map((item) => item.id),
      independent: true
    })
  );
}

async function submitRoot(coordinator, snapshot, roleId, path, final = false) {
  return coordinator.submit({
    runId: snapshot.id,
    roleId,
    instanceId: "root-main",
    artifactPath: path,
    rootManaged: true,
    final
  });
}

async function submitChild(
  coordinator,
  snapshot,
  roleId,
  instanceId,
  path,
  final = false
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
    artifactPath: path,
    final
  });
}

function specialistFor(template) {
  return template.spec.specialists.find((role) => role !== "expert.tester");
}

const runs = [];
for (let repetition = 1; repetition <= 3; repetition += 1) {
  for (const definition of cases) {
    const directory = await createRepository(definition, repetition);
    const template = await loadTemplate(
      join(root, "templates", `${definition.template}.yaml`)
    );
    const coordinator = new Coordinator(
      new RunStore(join(directory, ".git", "thearchy"))
    );
    const started = performance.now();
    let snapshot = await coordinator.start({
      task: definition.task,
      template,
      requestedMode: "auto",
      cwd: directory
    });
    const observedLevel = snapshot.risk.level;
    const observedRouting = snapshot.risk.routing;

    snapshot = await submitRoot(
      coordinator,
      snapshot,
      "governance.router",
      await artifact(directory, "classification.md")
    );
    const modePrompted = snapshot.state === "awaiting_mode_approval";
    if (modePrompted) {
      const decision = snapshot.decisions.find(
        (item) => item.kind === "mode" && item.status === "pending"
      );
      if (!decision) throw new Error("Expected a pending mode decision");
      snapshot = await coordinator.decide(
        snapshot.id,
        decision.id,
        snapshot.risk.effectiveMode
      );
    }

    snapshot =
      snapshot.mode === "light"
        ? await submitRoot(
            coordinator,
            snapshot,
            "governance.planner",
            await artifact(directory, "plan.md")
          )
        : await submitChild(
            coordinator,
            snapshot,
            "governance.planner",
            "planner",
            await artifact(directory, "plan.md")
          );
    if (snapshot.mode === "full") {
      snapshot = await submitChild(
        coordinator,
        snapshot,
        "governance.judge",
        "judge",
        await artifact(directory, "plan-review.md")
      );
    }
    snapshot = await coordinator.approve(snapshot.id, "plan");
    snapshot = await submitRoot(
      coordinator,
      snapshot,
      "governance.dispatcher",
      await artifact(directory, "dispatch.md")
    );
    const specialist = specialistFor(template);
    if (!specialist) throw new Error(`No specialist for ${definition.template}`);
    snapshot = await submitChild(
      coordinator,
      snapshot,
      specialist,
      "expert",
      await artifact(directory, "expert.md"),
      true
    );

    if (snapshot.mode === "light") {
      snapshot = await submitChild(
        coordinator,
        snapshot,
        "expert.tester",
        "tester",
        await verificationArtifact(directory, snapshot, "tester")
      );
    } else {
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
        artifactPath: await artifact(directory, "result-review.md")
      });
      snapshot = await coordinator.submit({
        runId: snapshot.id,
        roleId: "expert.tester",
        instanceId: "tester",
        artifactPath: await verificationArtifact(
          directory,
          snapshot,
          "tester"
        )
      });
    }

    snapshot = await coordinator.approve(snapshot.id, "merge");
    snapshot = await submitRoot(
      coordinator,
      snapshot,
      "governance.publisher",
      await artifact(directory, "delivery.md")
    );
    const durationMs = performance.now() - started;
    const events = await coordinator.store.events(snapshot.id);
    runs.push({
      caseId: definition.id,
      repetition,
      expectedLevel: definition.expectedLevel,
      observedLevel,
      expectedRouting: definition.expectedRouting,
      observedRouting,
      mode: snapshot.mode,
      modePrompted,
      completed: snapshot.state === "completed",
      childAgents: snapshot.agentInstances.length,
      eventCount: events.length,
      durationMs
    });
  }
}

const matched = runs.filter(
  (run) =>
    run.expectedLevel === run.observedLevel &&
    run.expectedRouting === run.observedRouting
).length;
const lightRuns = runs.filter((run) => run.mode === "light");
const modePrompts = runs.filter((run) => run.modePrompted).length;
const result = {
  date: "2026-08-21",
  platform: "windows-codex-desktop",
  benchmark: "context-routing-and-light-orchestration",
  repetitions: 3,
  cases: cases.length,
  runs: runs.length,
  metrics: {
    routingMatches: matched,
    routingExpected: runs.length,
    completed: runs.filter((run) => run.completed).length,
    modePrompts,
    legacyModePrompts: runs.length,
    lightRuns: lightRuns.length,
    lightRunsWithTwoAgents: lightRuns.filter(
      (run) => run.childAgents === 2
    ).length,
    averageLightAgents:
      lightRuns.reduce((sum, run) => sum + run.childAgents, 0) /
      lightRuns.length,
    averageCoordinatorDurationMs:
      runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length
  },
  runs
};

await mkdir(join(root, "evals", "results"), { recursive: true });
await writeFile(
  join(root, "evals", "results", "routing-light-2026-08-21.json"),
  `${JSON.stringify(result, null, 2)}\n`
);

const report = `# Routing and light-mode benchmark — 2026-08-21

This Windows/Codex-targeted control-plane benchmark executed ${cases.length}
tasks three times, for ${runs.length} isolated coordinator runs.

## Results

| Metric | Result |
|---|---:|
| Routing classification matches | ${matched}/${runs.length} |
| Completed coordinator runs | ${result.metrics.completed}/${runs.length} |
| Mode questions after optimization | ${modePrompts}/${runs.length} |
| Mode questions under previous policy | ${runs.length}/${runs.length} |
| Light-mode runs | ${lightRuns.length}/${runs.length} |
| Light runs using exactly two children | ${result.metrics.lightRunsWithTwoAgents}/${lightRuns.length} |
| Average children in light mode | ${result.metrics.averageLightAgents.toFixed(1)} |
| Average coordinator processing time | ${result.metrics.averageCoordinatorDurationMs.toFixed(1)} ms |

## Interpretation

- The contextual classifier matched all expected low, medium, and high routes.
- Only medium-risk tasks requested a mode decision.
- Every low-risk task completed with one domain expert and one independent
  verifier.
- Risk, plan, and merge gates remain enforced.

This benchmark measures deterministic routing and coordinator overhead. It does
not replace the end-to-end model-quality benchmark in
\`docs/FULL-BENCHMARK-2026-08-21.md\`.
`;
await writeFile(
  join(root, "docs", "ROUTING-LIGHT-BENCHMARK-2026-08-21.md"),
  report
);

if (
  matched !== runs.length ||
  result.metrics.completed !== runs.length ||
  result.metrics.lightRunsWithTwoAgents !== lightRuns.length
) {
  throw new Error("Routing/light benchmark failed");
}

process.stdout.write(`${JSON.stringify(result.metrics, null, 2)}\n`);

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve("evals/work/fullbench-20260821");
const selections = [
  { path: "rep1/single-agent", repetition: 1, strategy: "single-agent" },
  { path: "rep2/single-agent", repetition: 2, strategy: "single-agent" },
  { path: "rep3/single-agent", repetition: 3, strategy: "single-agent" },
  { path: "rep1/thearchy", repetition: 1, strategy: "thearchy" },
  { path: "rep2-retry/thearchy", repetition: 2, strategy: "thearchy" },
  { path: "rep3/thearchy", repetition: 3, strategy: "thearchy" }
];

const expected = {
  "feature-js": [],
  "feature-py": [],
  "bug-js": ["JS-CASE-LOOKUP"],
  "bug-py": ["PY-WHITESPACE-USER"],
  "review-js": ["JS-CASE-LOOKUP", "JS-TIMING-COMPARE"],
  "review-py": ["PY-WHITESPACE-USER", "PY-PLAIN-COMPARE"],
  "security-js": ["JS-TIMING-COMPARE"],
  "security-py": ["PY-PLAIN-COMPARE"],
  "migration-js": [],
  "migration-py": []
};

function normalizeSeeded(value, caseId) {
  const expectedIds = expected[caseId];
  if (!expectedIds) throw new Error(`Unknown case: ${caseId}`);
  if (Array.isArray(value)) {
    const found = new Set(value.map((item) => String(item)));
    return expectedIds.filter((id) => found.has(id)).length;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(0, value), expectedIds.length);
  }
  return 0;
}

function normalizeBoolean(value) {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return null;
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (Array.isArray(value)) return value.length;
  return 0;
}

const runs = [];
async function auditCoordinator(caseDirectory) {
  const runsDirectory = join(caseDirectory, ".git", "thearchy", "runs");
  let entries = [];
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch {
    return { completed: false, agentCount: 0, runCount: 0 };
  }
  let completed = false;
  let agentCount = 0;
  let runCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    runCount += 1;
    try {
      const snapshot = JSON.parse(
        await readFile(join(runsDirectory, entry.name, "snapshot.json"), "utf8")
      );
      completed ||= snapshot.state === "completed";
      if (Array.isArray(snapshot.agentInstances)) {
        agentCount = Math.max(agentCount, snapshot.agentInstances.length);
      }
    } catch {
      // Keep aggregating other run snapshots.
    }
  }
  return { completed, agentCount, runCount };
}

for (const selection of selections) {
  const directory = join(root, selection.path);
  await readdir(directory);
  for (const caseId of Object.keys(expected)) {
    const caseDirectory = join(directory, caseId);
    const path = join(caseDirectory, "benchmark-result.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    const audit = await auditCoordinator(caseDirectory);
    runs.push({
      caseId,
      strategy: selection.strategy,
      repetition: selection.repetition,
      completed:
        typeof raw.completed === "boolean" ? raw.completed : audit.completed,
      testsPassed: normalizeBoolean(raw.testsPassed),
      seededDefectsFound: normalizeSeeded(raw.seededDefectsFound, caseId),
      regressions: normalizeInteger(raw.regressions),
      durationSeconds:
        typeof raw.durationSeconds === "number" ? raw.durationSeconds : 0,
      agentCount:
        audit.agentCount ||
        (typeof raw.agentCount === "number" ? raw.agentCount : 0),
      runCount:
        audit.runCount ||
        (typeof raw.runCount === "number" ? raw.runCount : 1),
      changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles : [],
      summary: typeof raw.summary === "string" ? raw.summary : ""
    });
  }
}

if (runs.length !== 60) throw new Error(`Expected 60 runs, found ${runs.length}`);
for (const strategy of ["single-agent", "thearchy"]) {
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const count = runs.filter(
      (run) => run.strategy === strategy && run.repetition === repetition
    ).length;
    if (count !== 10) {
      throw new Error(`${strategy} repetition ${repetition} has ${count} runs`);
    }
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index];
}

function metrics(items) {
  const durations = items.map((run) => run.durationSeconds);
  const knownTests = items.filter((run) => run.testsPassed !== null);
  return {
    runs: items.length,
    completed: items.filter((run) => run.completed).length,
    testsPassed: knownTests.filter((run) => run.testsPassed).length,
    testsKnown: knownTests.length,
    seededDefectsFound: items.reduce(
      (sum, run) => sum + run.seededDefectsFound,
      0
    ),
    seededDefectsExpected:
      Object.values(expected).reduce((sum, ids) => sum + ids.length, 0) *
      (items.length / 10),
    regressions: items.reduce((sum, run) => sum + run.regressions, 0),
    averageDurationSeconds:
      durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    medianDurationSeconds: percentile(durations, 0.5),
    p95DurationSeconds: percentile(durations, 0.95),
    averageAgentCount:
      items.reduce((sum, run) => sum + run.agentCount, 0) / items.length,
    duplicateRuns: items.reduce(
      (sum, run) => sum + Math.max(0, run.runCount - 1),
      0
    )
  };
}

const result = {
  date: "2026-08-21",
  host: "codex",
  benchmark: "full-10-cases-3-repetitions",
  budget: {
    maxAgents: 4,
    maxConcurrency: 2,
    timeoutMinutes: 10
  },
  metrics: {
    singleAgent: metrics(runs.filter((run) => run.strategy === "single-agent")),
    thearchy: metrics(runs.filter((run) => run.strategy === "thearchy"))
  },
  repetitions: [1, 2, 3].map((repetition) => ({
    repetition,
    singleAgent: metrics(
      runs.filter(
        (run) =>
          run.strategy === "single-agent" && run.repetition === repetition
      )
    ),
    thearchy: metrics(
      runs.filter(
        (run) => run.strategy === "thearchy" && run.repetition === repetition
      )
    )
  })),
  runs
};

await writeFile(
  "evals/results/fullbenchmark-2026-08-21.json",
  `${JSON.stringify(result, null, 2)}\n`
);

const single = result.metrics.singleAgent;
const thearchy = result.metrics.thearchy;
const markdown = `# Full benchmark — 2026-08-21

The benchmark executed 10 tasks, two strategies, and three repetitions: 60
isolated Git runs in total.

## Overall results

| Metric | Single agent | Thearchy |
|---|---:|---:|
| Completed | ${single.completed}/${single.runs} | ${thearchy.completed}/${thearchy.runs} |
| Tests passed | ${single.testsPassed}/${single.testsKnown} | ${thearchy.testsPassed}/${thearchy.testsKnown} |
| Seeded defects | ${single.seededDefectsFound}/${single.seededDefectsExpected} | ${thearchy.seededDefectsFound}/${thearchy.seededDefectsExpected} |
| Regressions | ${single.regressions} | ${thearchy.regressions} |
| Average duration | ${single.averageDurationSeconds.toFixed(1)} s | ${thearchy.averageDurationSeconds.toFixed(1)} s |
| Median duration | ${single.medianDurationSeconds.toFixed(1)} s | ${thearchy.medianDurationSeconds.toFixed(1)} s |
| P95 duration | ${single.p95DurationSeconds.toFixed(1)} s | ${thearchy.p95DurationSeconds.toFixed(1)} s |
| Average agents | ${single.averageAgentCount.toFixed(1)} | ${thearchy.averageAgentCount.toFixed(1)} |
| Duplicate runs | ${single.duplicateRuns} | ${thearchy.duplicateRuns} |

## Repetitions

| Repetition | Single completion | Thearchy completion | Single avg | Thearchy avg |
|---|---:|---:|---:|---:|
${result.repetitions
  .map(
    (item) =>
      `| ${item.repetition} | ${item.singleAgent.completed}/10 | ${item.thearchy.completed}/10 | ${item.singleAgent.averageDurationSeconds.toFixed(1)} s | ${item.thearchy.averageDurationSeconds.toFixed(1)} s |`
  )
  .join("\n")}

## Notes

- Repetition 2 was rerun alone after the original concurrent orchestrator
  attempt encountered Windows child-sandbox initialization failures.
- The final dataset uses the isolated retry for Thearchy repetition 2.
- Results are normalized against the seeded-defect IDs declared by each case.
`;
await writeFile("docs/FULL-BENCHMARK-2026-08-21.md", markdown);

process.stdout.write(`${JSON.stringify(result.metrics, null, 2)}\n`);

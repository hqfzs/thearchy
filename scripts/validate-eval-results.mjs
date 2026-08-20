import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "evals/results/prebenchmark-2026-08-20.json";
const result = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(result.runs) || result.runs.length !== 20) {
  throw new Error("Pre-benchmark must contain exactly 20 runs");
}

const expectedCases = new Set([
  "feature-js",
  "feature-py",
  "bug-js",
  "bug-py",
  "review-js",
  "review-py",
  "security-js",
  "security-py",
  "migration-js",
  "migration-py"
]);
for (const strategy of ["single-agent", "thearchy"]) {
  const runs = result.runs.filter((run) => run.strategy === strategy);
  if (runs.length !== 10) throw new Error(`${strategy} must contain 10 runs`);
  const cases = new Set(runs.map((run) => run.caseId));
  for (const id of expectedCases) {
    if (!cases.has(id)) throw new Error(`${strategy} is missing ${id}`);
  }
}
for (const run of result.runs) {
  if (typeof run.completed !== "boolean") throw new Error("completed must be boolean");
  if (![true, false, null].includes(run.testsPassed)) {
    throw new Error("testsPassed must be boolean or null");
  }
  for (const key of [
    "seededDefectsFound",
    "regressions",
    "durationSeconds",
    "agentCount"
  ]) {
    if (typeof run[key] !== "number" || run[key] < 0) {
      throw new Error(`${key} must be a non-negative number`);
    }
  }
}

function metrics(strategy) {
  const runs = result.runs.filter((run) => run.strategy === strategy);
  return {
    completed: runs.filter((run) => run.completed).length,
    seededDefectsFound: runs.reduce(
      (total, run) => total + run.seededDefectsFound,
      0
    ),
    averageDurationSeconds:
      runs.reduce((total, run) => total + run.durationSeconds, 0) / runs.length,
    averageAgentCount:
      runs.reduce((total, run) => total + run.agentCount, 0) / runs.length
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      singleAgent: metrics("single-agent"),
      thearchy: metrics("thearchy")
    },
    null,
    2
  )}\n`
);

import { readFile } from "node:fs/promises";
import { assessRisk } from "../packages/core/dist/index.js";

const source = JSON.parse(
  await readFile("evals/risk-cases.json", "utf8")
);
if (!Array.isArray(source.cases) || source.cases.length !== 50) {
  throw new Error("Risk corpus must contain exactly 50 cases");
}

const presets = {
  clean: {
    gitStatus: "clean",
    gitAvailable: true,
    dirtyWorkingTree: false,
    dirtyFileCount: 0,
    sensitivePathsChanged: false,
    hasVerification: true,
    verificationCommands: [{ capability: "test", command: "npm test" }],
    projectKinds: ["javascript-typescript"]
  },
  dirty: {
    gitStatus: "dirty",
    gitAvailable: true,
    dirtyWorkingTree: true,
    dirtyFileCount: 1,
    sensitivePathsChanged: false,
    hasVerification: true,
    verificationCommands: [{ capability: "test", command: "npm test" }],
    projectKinds: ["javascript-typescript"]
  },
  "dirty-sensitive": {
    gitStatus: "dirty",
    gitAvailable: true,
    dirtyWorkingTree: true,
    dirtyFileCount: 4,
    sensitivePathsChanged: true,
    hasVerification: true,
    verificationCommands: [{ capability: "test", command: "npm test" }],
    projectKinds: ["javascript-typescript"]
  },
  "no-tests": {
    gitStatus: "clean",
    gitAvailable: true,
    dirtyWorkingTree: false,
    dirtyFileCount: 0,
    sensitivePathsChanged: false,
    hasVerification: false,
    verificationCommands: [],
    projectKinds: ["javascript-typescript"]
  }
};

const results = source.cases.map((item) => {
  const context = {
    ...presets[item.context],
    templateId: item.template
  };
  const assessment = assessRisk(item.task, "auto", context);
  return {
    id: item.id,
    expected: item.expected,
    actual: assessment.level,
    routing: assessment.routing,
    passed: assessment.level === item.expected
  };
});
const correct = results.filter((item) => item.passed).length;
const highMisses = results.filter(
  (item) => item.expected === "high" && item.actual !== "high"
).length;
const lowCases = results.filter((item) => item.expected === "low");
const lowEscalations = lowCases.filter((item) => item.actual !== "low").length;
const accuracy = correct / results.length;
const lowEscalationRate = lowEscalations / lowCases.length;

if (accuracy < 0.9) throw new Error(`Risk accuracy below 90%: ${accuracy}`);
if (highMisses !== 0) throw new Error(`High-risk misses: ${highMisses}`);
if (lowEscalationRate > 0.15) {
  throw new Error(`Low-risk escalation rate above 15%: ${lowEscalationRate}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      cases: results.length,
      correct,
      accuracy,
      highMisses,
      lowEscalations,
      lowEscalationRate,
      failures: results.filter((item) => !item.passed)
    },
    null,
    2
  )}\n`
);

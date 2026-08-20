import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifest = JSON.parse(await readFile("evals/cases.json", "utf8"));
if (!Array.isArray(manifest.cases) || manifest.cases.length !== 10) {
  throw new Error("Evaluation manifest must contain exactly 10 cases");
}

const templates = new Map();
const languages = new Map();
for (const item of manifest.cases) {
  if (!item.id || !item.template || !item.language || !item.fixture) {
    throw new Error(`Invalid evaluation case: ${JSON.stringify(item)}`);
  }
  templates.set(item.template, (templates.get(item.template) ?? 0) + 1);
  languages.set(item.language, (languages.get(item.language) ?? 0) + 1);
  await access(resolve(item.fixture));
}

for (const id of [
  "feature-delivery",
  "bug-repair",
  "code-review",
  "security-review",
  "refactor-migration"
]) {
  if (templates.get(id) !== 2) {
    throw new Error(`Template ${id} must have exactly two evaluation cases`);
  }
}
if (languages.get("javascript") !== 5 || languages.get("python") !== 5) {
  throw new Error("Evaluation cases must be split evenly between JavaScript and Python");
}

process.stdout.write("Evaluation manifest is valid: 10 cases, 5 templates, 2 languages.\n");

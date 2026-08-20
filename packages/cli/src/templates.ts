import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  assertRemoteTemplateFile,
  loadTemplates,
  sha256File,
  type TeamTemplate
} from "@thearchy/core";
import {
  builtinTemplatesDirectory,
  userTemplatesDirectory
} from "./paths.js";

export async function allTemplates(): Promise<TeamTemplate[]> {
  const builtins = await loadTemplates(builtinTemplatesDirectory());
  try {
    const users = await loadTemplates(userTemplatesDirectory());
    const merged = new Map(builtins.map((template) => [template.metadata.id, template]));
    for (const template of users) merged.set(template.metadata.id, template);
    return [...merged.values()];
  } catch {
    return builtins;
  }
}

export async function findTemplate(id: string): Promise<TeamTemplate> {
  const templates = await allTemplates();
  const template = templates.find((item) => item.metadata.id === id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  return template;
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported template entry: ${path}`);
  }
  return files;
}

async function validateRemoteDirectory(path: string): Promise<void> {
  for (const file of await walkFiles(path)) {
    assertRemoteTemplateFile(file);
  }
  await loadTemplates(path);
}

function clone(source: string, destination: string, ref?: string): void {
  const args = ["clone", "--depth", "1", "--no-tags"];
  if (ref) args.push("--branch", ref);
  args.push(source, destination);
  const result = spawnSync(
    "git",
    args,
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to clone template repository");
  }
}

export async function addTemplate(source: string): Promise<{
  installed: string[];
  lockFile: string;
}> {
  const home = userTemplatesDirectory();
  await mkdir(home, { recursive: true });
  let sourceDirectory = resolve(source);
  let sourceFilePath: string | undefined;
  let temporary: string | undefined;
  let remoteSource: string | undefined;
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:#.*)?$/.test(source)) {
    const [repository, ref] = source.split("#", 2);
    temporary = await mkdtemp(join(tmpdir(), "thearchy-template-"));
    clone(repository!, temporary, ref);
    sourceDirectory = temporary;
    remoteSource = source;
  } else {
    const info = await stat(sourceDirectory);
    if (info.isFile()) {
      assertRemoteTemplateFile(sourceDirectory);
      sourceFilePath = sourceDirectory;
      sourceDirectory = resolve(sourceDirectory, "..");
    }
  }

  try {
    if (sourceFilePath) {
      await loadTemplates(sourceFilePath);
    } else {
      await validateRemoteDirectory(sourceDirectory);
    }
    const templates = await loadTemplates(sourceFilePath ?? sourceDirectory);
    const installed: string[] = [];
    const lockEntries: Array<Record<string, string>> = [];
    const availableFiles = sourceFilePath
      ? [sourceFilePath]
      : await walkFiles(sourceDirectory);
    for (const template of templates) {
      const sourceFile = availableFiles.find(
        (file) =>
          basename(file) === `${template.metadata.id}.yaml` ||
          basename(file) === `${template.metadata.id}.yml`
      );
      if (!sourceFile) {
        throw new Error(
          `Template file must be named ${template.metadata.id}.yaml`
        );
      }
      const destination = join(home, basename(sourceFile));
      await cp(sourceFile, destination, { force: true });
      installed.push(template.metadata.id);
      lockEntries.push({
        id: template.metadata.id,
        version: template.metadata.version,
        source: remoteSource ?? sourceDirectory,
        sha256: await sha256File(destination)
      });
    }
    const lockFile = join(home, "templates.lock.json");
    let existing: Array<Record<string, string>> = [];
    try {
      existing = JSON.parse(await readFile(lockFile, "utf8")) as Array<
        Record<string, string>
      >;
    } catch {
      existing = [];
    }
    const merged = new Map(existing.map((entry) => [entry.id, entry]));
    for (const entry of lockEntries) merged.set(entry.id, entry);
    await writeFile(lockFile, JSON.stringify([...merged.values()], null, 2));
    return { installed, lockFile };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function removeTemplate(id: string): Promise<void> {
  const home = userTemplatesDirectory();
  for (const extension of [".yaml", ".yml"]) {
    await rm(join(home, `${id}${extension}`), { force: true });
  }
  const lockFile = join(home, "templates.lock.json");
  try {
    const entries = JSON.parse(await readFile(lockFile, "utf8")) as Array<
      Record<string, string>
    >;
    await writeFile(
      lockFile,
      JSON.stringify(entries.filter((entry) => entry.id !== id), null, 2)
    );
  } catch {
    // No lock file is a valid state.
  }
}

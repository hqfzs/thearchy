import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "thearchy-package-"));
const artifacts = join(directory, "artifacts");
const installRoot = join(directory, "install");
await mkdir(artifacts, { recursive: true });
await mkdir(installRoot, { recursive: true });

function npm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is unavailable");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr ||
        result.stdout ||
        `npm ${args.join(" ")} failed`
    );
  }
}

npm(["pack", "--workspace", "packages/cli", "--pack-destination", artifacts]);
const tarball = (await readdir(artifacts)).find((name) => name.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack did not create a tarball");
npm(["install", "--prefix", installRoot, join(artifacts, tarball)]);

const installedCli = join(
  installRoot,
  "node_modules",
  "thearchy-cli",
  "dist",
  "bin",
  "thearchy.js"
);
const run = spawnSync(process.execPath, [installedCli, "--version"], {
  encoding: "utf8",
  windowsHide: true
});
if (run.status !== 0) throw new Error(run.stderr || run.stdout);
if (!run.stdout.trim().startsWith("0.2.0-beta.1")) {
  throw new Error(`Unexpected packaged CLI version: ${run.stdout.trim()}`);
}

process.stdout.write("Package smoke passed: tarball installed and executed.\n");

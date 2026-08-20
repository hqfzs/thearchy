import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("packages/cli/dist/bin");
await mkdir(outputDirectory, { recursive: true });

await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["./packages/cli/dist/index.js"],
  outfile: "./packages/cli/dist/bin/thearchy.js",
  bundle: true,
  external: ["yaml"],
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "none"
});

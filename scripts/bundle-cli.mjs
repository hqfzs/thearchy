import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("packages/cli/dist/bin");
await mkdir(outputDirectory, { recursive: true });
const embeddedDirectory = resolve("packages/cli/dist/embedded");
await mkdir(embeddedDirectory, { recursive: true });

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

await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["./packages/cli/dist/index.js"],
  outfile: "./packages/cli/dist/embedded/thearchy.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  banner: {
    js: "import { createRequire as __thearchyCreateRequire } from 'node:module'; const require = __thearchyCreateRequire(import.meta.url);"
  },
  legalComments: "none"
});

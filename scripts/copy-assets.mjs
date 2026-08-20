import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const destination = resolve("packages/cli/dist/assets");
await mkdir(destination, { recursive: true });

for (const name of ["templates", "roles", "skills"]) {
  await cp(resolve(name), resolve(destination, name), { recursive: true, force: true });
}

await cp(resolve("plugin.json"), resolve(destination, "plugin.json"), { force: true });

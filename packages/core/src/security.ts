import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const REMOTE_TEMPLATE_EXTENSIONS = new Set([
  ".yaml",
  ".yml",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg"
]);

const SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "service-account.json"
]);

const SECRET_SEGMENTS = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube"
];

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`Path escapes allowed root: ${candidate}`);
}

export async function assertNoSymlinkEscape(
  root: string,
  candidate: string
): Promise<string> {
  const safeCandidate = assertPathInside(root, candidate);
  const realRoot = await realpath(resolve(root));
  try {
    return assertPathInside(realRoot, await realpath(safeCandidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const realParent = await realpath(dirname(safeCandidate));
    assertPathInside(realRoot, realParent);
    return safeCandidate;
  }
}

export function isSecretPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  return (
    SECRET_BASENAMES.has(name) ||
    SECRET_SEGMENTS.some(
      (segment) =>
        normalized.includes(`/${segment}/`) ||
        normalized.endsWith(`/${segment}`)
    )
  );
}

export function assertRemoteTemplateFile(path: string): void {
  const extension = extname(path).toLowerCase();
  const normalizedName = basename(path).toLowerCase();
  if (
    [
      "package.json",
      "plugin.json",
      "hooks.json",
      ".mcp.json",
      "marketplace.json"
    ].includes(normalizedName)
  ) {
    throw new Error(`Remote template contains executable configuration: ${path}`);
  }
  if (!REMOTE_TEMPLATE_EXTENSIONS.has(extension)) {
    throw new Error(`Remote template contains forbidden file type: ${path}`);
  }
  if (
    [".js", ".cjs", ".mjs", ".ts", ".sh", ".ps1", ".bat", ".cmd", ".exe"].includes(
      extension
    )
  ) {
    throw new Error(`Remote template may not contain executable files: ${path}`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g,
      "[REDACTED_TOKEN]"
    )
    .replace(
      /(password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=[REDACTED]"
    );
}

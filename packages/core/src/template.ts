import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ROLE_BY_ID } from "./roles.js";
import type {
  TeamTemplate,
  TemplateProfile,
  VerificationCapability
} from "./types.js";

const TEMPLATE_API_VERSION = "thearchy.dev/v1alpha1";
const TEMPLATE_KIND = "TeamTemplate";
const VERIFICATION_CAPABILITIES = new Set<VerificationCapability>([
  "test",
  "lint",
  "build",
  "typecheck",
  "security-scan"
]);

function requireObject(
  value: unknown,
  location: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${location} must be an array of strings`);
  }
  return [...value];
}

function parseProfile(value: unknown, location: string): TemplateProfile {
  const profile = requireObject(value, location);
  const strategy = profile.strategy;
  if (strategy !== "single" && strategy !== "competitive") {
    throw new Error(`${location}.strategy must be single or competitive`);
  }

  const result: TemplateProfile = { strategy };
  for (const key of [
    "maxAgents",
    "maxConcurrency",
    "timeoutMinutes",
    "maxPlanReworks",
    "maxResultReworks",
    "maxCompetingImplementations"
  ] as const) {
    const raw = profile[key];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        throw new Error(`${location}.${key} must be a non-negative number`);
      }
      result[key] = raw;
    }
  }
  return result;
}

function parseCapabilities(
  value: unknown,
  location: string
): VerificationCapability[] {
  const capabilities = stringArray(value, location);
  for (const capability of capabilities) {
    if (!VERIFICATION_CAPABILITIES.has(capability as VerificationCapability)) {
      throw new Error(`${location} contains unsupported capability: ${capability}`);
    }
  }
  return capabilities as VerificationCapability[];
}

function requireSemver(value: string, location: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${location} must use semantic versioning`);
  }
  return value;
}

export function validateTemplate(input: unknown): TeamTemplate {
  const root = requireObject(input, "template");
  if (root.apiVersion !== TEMPLATE_API_VERSION) {
    throw new Error(`apiVersion must be ${TEMPLATE_API_VERSION}`);
  }
  if (root.kind !== TEMPLATE_KIND) {
    throw new Error(`kind must be ${TEMPLATE_KIND}`);
  }

  const metadata = requireObject(root.metadata, "metadata");
  const spec = requireObject(root.spec, "spec");
  const profiles = requireObject(spec.profiles, "spec.profiles");
  const permissions = requireObject(spec.permissions, "spec.permissions");
  const verification = requireObject(spec.verification, "spec.verification");

  const governance = stringArray(spec.governance, "spec.governance");
  const specialists = stringArray(spec.specialists, "spec.specialists");
  for (const roleId of [...governance, ...specialists]) {
    if (!ROLE_BY_ID.has(roleId)) {
      throw new Error(`Unknown role id: ${roleId}`);
    }
  }

  const parsePermission = (key: string): "deny" | "approval" => {
    const value = permissions[key];
    if (value !== "deny" && value !== "approval") {
      throw new Error(`spec.permissions.${key} must be deny or approval`);
    }
    return value;
  };

  const template: TeamTemplate = {
    apiVersion: TEMPLATE_API_VERSION,
    kind: TEMPLATE_KIND,
    metadata: {
      id: requireString(metadata.id, "metadata.id"),
      version: requireSemver(
        requireString(metadata.version, "metadata.version"),
        "metadata.version"
      ),
      displayName: requireString(metadata.displayName, "metadata.displayName")
    },
    spec: {
      triggers: stringArray(spec.triggers ?? [], "spec.triggers"),
      profiles: {
        light: parseProfile(profiles.light, "spec.profiles.light"),
        full: parseProfile(profiles.full, "spec.profiles.full")
      },
      governance,
      specialists,
      stages: stringArray(spec.stages, "spec.stages"),
      qualityGates: stringArray(spec.qualityGates, "spec.qualityGates"),
      capabilities: parseCapabilities(
        spec.capabilities ?? [],
        "spec.capabilities"
      ),
      permissions: {
        network: parsePermission("network"),
        dependencyInstall: parsePermission("dependencyInstall"),
        destructive: parsePermission("destructive"),
        externalWrite: parsePermission("externalWrite")
      },
      verification: {
        required: parseCapabilities(
          verification.required ?? [],
          "spec.verification.required"
        ),
        optional: parseCapabilities(
          verification.optional ?? [],
          "spec.verification.optional"
        )
      }
    }
  };

  if (typeof metadata.description === "string") {
    template.metadata.description = metadata.description;
  }
  return template;
}

export async function loadTemplate(path: string): Promise<TeamTemplate> {
  const source = await readFile(path, "utf8");
  return validateTemplate(parseYaml(source));
}

export async function loadTemplates(path: string): Promise<TeamTemplate[]> {
  const info = await stat(path);
  if (info.isFile()) {
    return [await loadTemplate(path)];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const templates: TeamTemplate[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || ![".yaml", ".yml"].includes(extname(entry.name))) {
      continue;
    }
    templates.push(await loadTemplate(join(path, entry.name)));
  }
  if (templates.length === 0) {
    throw new Error(`No YAML templates found in ${path}`);
  }
  return templates;
}

export function migrateTemplate(input: unknown): TeamTemplate {
  const root = requireObject(input, "template");
  if (root.apiVersion === TEMPLATE_API_VERSION) {
    return validateTemplate(input);
  }
  throw new Error(`No migration path for apiVersion ${String(root.apiVersion)}`);
}

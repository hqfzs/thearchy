import { createHash } from "node:crypto";
import type {
  CapabilityAvailability,
  HostRuntimeReport
} from "./types.js";

const AVAILABILITY = new Set<CapabilityAvailability>([
  "available",
  "unavailable",
  "unknown"
]);

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hostRuntimeReportHash(
  report: Omit<HostRuntimeReport, "reportHash">
): string {
  return createHash("sha256").update(canonicalize(report)).digest("hex");
}

export function createHostRuntimeReport(input: {
  subagents: CapabilityAvailability;
  parallelAgents: CapabilityAvailability;
  choicePrompt: CapabilityAvailability;
  checkedAt?: string;
}): HostRuntimeReport {
  const report = {
    host: "codex" as const,
    platform: "win32" as const,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    source: "codex-runtime" as const,
    capabilities: {
      subagents: input.subagents,
      parallelAgents: input.parallelAgents,
      choicePrompt: input.choicePrompt
    }
  };
  return { ...report, reportHash: hostRuntimeReportHash(report) };
}

export function validateHostRuntimeReport(input: unknown): HostRuntimeReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Host runtime report must be an object");
  }
  const report = input as Record<string, unknown>;
  const allowed = new Set([
    "host",
    "platform",
    "checkedAt",
    "source",
    "capabilities",
    "reportHash"
  ]);
  for (const key of Object.keys(report)) {
    if (!allowed.has(key)) throw new Error(`Unknown host report field: ${key}`);
  }
  if (report.host !== "codex") throw new Error("Host must be codex");
  if (report.platform !== "win32") throw new Error("Platform must be win32");
  if (report.source !== "codex-runtime") {
    throw new Error("Host report source must be codex-runtime");
  }
  if (
    typeof report.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(report.checkedAt))
  ) {
    throw new Error("checkedAt must be an ISO-8601 timestamp");
  }
  const capabilities = report.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("capabilities must be an object");
  }
  const values = capabilities as Record<string, unknown>;
  for (const key of ["subagents", "parallelAgents", "choicePrompt"]) {
    if (!AVAILABILITY.has(values[key] as CapabilityAvailability)) {
      throw new Error(`Invalid capability availability: ${key}`);
    }
  }
  if (
    typeof report.reportHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.reportHash)
  ) {
    throw new Error("reportHash must be a SHA-256 hex digest");
  }
  const normalized: HostRuntimeReport = {
    host: "codex",
    platform: "win32",
    checkedAt: report.checkedAt,
    source: "codex-runtime",
    capabilities: {
      subagents: values.subagents as CapabilityAvailability,
      parallelAgents: values.parallelAgents as CapabilityAvailability,
      choicePrompt: values.choicePrompt as CapabilityAvailability
    },
    reportHash: report.reportHash
  };
  const { reportHash: _hash, ...payload } = normalized;
  if (hostRuntimeReportHash(payload) !== normalized.reportHash) {
    throw new Error("Host runtime report hash mismatch");
  }
  return normalized;
}


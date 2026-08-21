import type {
  RunSnapshot,
  VerificationCapability,
  VerificationResult,
  VerificationStatus
} from "./types.js";

const CAPABILITIES = new Set<VerificationCapability>([
  "test",
  "lint",
  "build",
  "typecheck",
  "security-scan"
]);

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

export function validateVerificationResult(
  input: unknown,
  snapshot: RunSnapshot,
  submittingInstanceId: string
): VerificationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Verification result must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.apiVersion !== "thearchy.dev/verification/v1") {
    throw new Error(
      "Verification result apiVersion must be thearchy.dev/verification/v1"
    );
  }
  if (!["passed", "failed", "unverified"].includes(String(value.status))) {
    throw new Error("Verification result status is invalid");
  }
  if (value.attemptStatus !== "submitted") {
    throw new Error("Verification attemptStatus must be submitted");
  }
  if (
    typeof value.attempt !== "number" ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 1
  ) {
    throw new Error("Verification attempt must be a positive integer");
  }
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Verification createdAt must be an ISO-8601 timestamp");
  }
  const verifierInstanceId = nonEmptyString(
    value.verifierInstanceId,
    "verifierInstanceId"
  );
  if (verifierInstanceId !== submittingInstanceId) {
    throw new Error("Verifier instance does not match the submitting instance");
  }
  const implementerInstanceIds = stringArray(
    value.implementerInstanceIds,
    "implementerInstanceIds"
  );
  if (implementerInstanceIds.includes(verifierInstanceId)) {
    throw new Error("Verifier must be independent from implementers");
  }
  const actualImplementers = [
    ...new Set(
      snapshot.artifacts
        .filter(
          (artifact) =>
            artifact.final &&
            artifact.roleId.startsWith("expert.") &&
            artifact.roleId !== "expert.tester"
        )
        .map((artifact) => artifact.instanceId)
    )
  ].sort();
  if (
    JSON.stringify([...implementerInstanceIds].sort()) !==
    JSON.stringify(actualImplementers)
  ) {
    throw new Error("implementerInstanceIds do not match this run");
  }
  const reviewedArtifactIds = stringArray(
    value.reviewedArtifactIds,
    "reviewedArtifactIds"
  );
  const knownArtifacts = new Set(snapshot.artifacts.map((item) => item.id));
  if (reviewedArtifactIds.some((id) => !knownArtifacts.has(id))) {
    throw new Error("Verification references an unknown run artifact");
  }
  if (!Array.isArray(value.commands)) {
    throw new Error("Verification commands must be an array");
  }
  const commands = value.commands.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`commands[${index}] must be an object`);
    }
    const command = item as Record<string, unknown>;
    if (!CAPABILITIES.has(command.capability as VerificationCapability)) {
      throw new Error(`commands[${index}].capability is invalid`);
    }
    if (
      command.exitCode !== null &&
      (typeof command.exitCode !== "number" ||
        !Number.isInteger(command.exitCode))
    ) {
      throw new Error(`commands[${index}].exitCode is invalid`);
    }
    if (
      typeof command.durationMs !== "number" ||
      !Number.isInteger(command.durationMs) ||
      command.durationMs < 0
    ) {
      throw new Error(`commands[${index}].durationMs is invalid`);
    }
    return {
      capability: command.capability as VerificationCapability,
      command: nonEmptyString(command.command, `commands[${index}].command`),
      exitCode: command.exitCode as number | null,
      durationMs: command.durationMs,
      ...(typeof command.evidence === "string"
        ? { evidence: command.evidence }
        : {})
    };
  });
  if (!Array.isArray(value.findings)) {
    throw new Error("Verification findings must be an array");
  }
  const findings = value.findings.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    const finding = item as Record<string, unknown>;
    if (!["low", "medium", "high"].includes(String(finding.severity))) {
      throw new Error(`findings[${index}].severity is invalid`);
    }
    return {
      severity: finding.severity as "low" | "medium" | "high",
      summary: nonEmptyString(finding.summary, `findings[${index}].summary`),
      ...(typeof finding.evidence === "string"
        ? { evidence: finding.evidence }
        : {})
    };
  });
  const requiredCapabilities = new Set(snapshot.requiredVerification);
  const commandByCapability = new Map(
    commands.map((command) => [command.capability, command])
  );
  let computedStatus: VerificationStatus = "passed";
  if (
    findings.some((finding) => finding.severity === "high") ||
    [...requiredCapabilities].some(
      (capability) =>
        commandByCapability.has(capability) &&
        commandByCapability.get(capability)?.exitCode !== 0
    )
  ) {
    computedStatus = "failed";
  } else if (
    (requiredCapabilities.size === 0 && commands.length === 0) ||
    [...requiredCapabilities].some(
      (capability) =>
        !commandByCapability.has(capability) ||
        commandByCapability.get(capability)?.exitCode === null
    )
  ) {
    computedStatus = "unverified";
  }
  const unverifiedReason = value.unverifiedReason;
  if (
    computedStatus === "unverified" &&
    ![
      "no-verification-command",
      "command-not-executable",
      "evidence-missing"
    ].includes(String(unverifiedReason))
  ) {
    throw new Error("Unverified results require an unverifiedReason");
  }
  if (
    computedStatus !== "unverified" &&
    reviewedArtifactIds.length === 0
  ) {
    throw new Error("Verified results must reference reviewed artifacts");
  }
  if (
    computedStatus === "unverified" &&
    unverifiedReason === "evidence-missing" &&
    reviewedArtifactIds.length === 0
  ) {
    throw new Error("evidence-missing must reference reviewed artifacts");
  }
  if (value.independent !== true) {
    throw new Error("Verification result must declare independent=true");
  }
  return {
    apiVersion: "thearchy.dev/verification/v1",
    status: computedStatus,
    attemptStatus: "submitted",
    attempt: value.attempt,
    createdAt: value.createdAt,
    verifierInstanceId,
    implementerInstanceIds,
    commands,
    findings,
    reviewedArtifactIds,
    independent: true,
    ...(computedStatus === "unverified"
      ? {
          unverifiedReason: unverifiedReason as
            | "no-verification-command"
            | "command-not-executable"
            | "evidence-missing"
        }
      : {})
  };
}

import { execSync } from "node:child_process";
import type {
  EnrichedDiagnostic,
  EnvironmentGuards,
} from "@exit-zero-labs/httpi-contracts";
import { finalizeDiagnostic } from "@exit-zero-labs/httpi-definitions";
import { exitCodes, HttpiError } from "@exit-zero-labs/httpi-shared";

export interface GuardFlags {
  [flag: string]: boolean | undefined;
}

export function evaluateEnvironmentGuards(
  guards: EnvironmentGuards | undefined,
  envId: string,
  cliFlags?: GuardFlags,
  resolvedUrls?: string[],
): void {
  if (!guards) return;

  const failures: EnrichedDiagnostic[] = [];

  // requireEnv guard
  if (guards.requireEnv) {
    const eqIndex = guards.requireEnv.indexOf("=");
    const envName =
      eqIndex >= 0 ? guards.requireEnv.slice(0, eqIndex) : guards.requireEnv;
    const envValue =
      eqIndex >= 0 ? guards.requireEnv.slice(eqIndex + 1) : undefined;

    if (envName.length === 0) {
      failures.push(
        finalizeDiagnostic({
          level: "error",
          code: "GUARD_REQUIRE_ENV",
          message: "Environment guard requireEnv has an empty variable name.",
          hint: `Fix the requireEnv value in the ${envId} environment definition.`,
        }),
      );
    } else {
      const actual = process.env[envName];
      if (envValue !== undefined) {
        if (actual !== envValue) {
          failures.push(
            finalizeDiagnostic({
              level: "error",
              code: "GUARD_REQUIRE_ENV",
              message: `Environment guard requires ${envName}=${envValue} but got ${actual ?? "<unset>"}.`,
              hint: `Set ${envName}=${envValue} in your environment before running against ${envId}.`,
            }),
          );
        }
      } else if (actual === undefined) {
        failures.push(
          finalizeDiagnostic({
            level: "error",
            code: "GUARD_REQUIRE_ENV",
            message: `Environment guard requires ${envName} to be set.`,
            hint: `Set ${envName} in your environment before running against ${envId}.`,
          }),
        );
      }
    }
  }

  // requireFlag guard — checks against the actual flag name
  if (guards.requireFlag) {
    const flagName = guards.requireFlag.replace(/^--/, "");
    const camelFlag = flagName.replace(/-([a-z])/g, (_, c: string) =>
      c.toUpperCase(),
    );
    const flagSet = cliFlags?.[camelFlag] || cliFlags?.[flagName];
    if (!flagSet) {
      failures.push(
        finalizeDiagnostic({
          level: "error",
          code: "GUARD_REQUIRE_FLAG",
          message: `Environment ${envId} requires the ${guards.requireFlag} flag.`,
          hint: `Add ${guards.requireFlag} to your command to run against ${envId}.`,
        }),
      );
    }
  }

  // blockParallelAbove guard
  if (guards.blockParallelAbove !== undefined) {
    // This guard is evaluated at compile time against the run's parallel step concurrency
    // For now, we store it and the execution layer checks it when running parallel steps
    // The guard value is available on the compiled environment for the session executor to check
  }

  // blockIfBranchNotIn guard
  if (guards.blockIfBranchNotIn && guards.blockIfBranchNotIn.length > 0) {
    try {
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        encoding: "utf8",
      }).trim();
      if (!guards.blockIfBranchNotIn.includes(currentBranch)) {
        failures.push(
          finalizeDiagnostic({
            level: "error",
            code: "GUARD_BRANCH",
            message: `Environment ${envId} is restricted to branches: ${guards.blockIfBranchNotIn.join(", ")}. Current branch: ${currentBranch}.`,
            hint: `Switch to one of ${guards.blockIfBranchNotIn.join(", ")} before running against ${envId}.`,
          }),
        );
      }
    } catch {
      failures.push(
        finalizeDiagnostic({
          level: "error",
          code: "GUARD_BRANCH",
          message:
            "Could not determine current git branch for environment guard.",
          hint: "Ensure you are in a git repository.",
        }),
      );
    }
  }

  // denyHosts guard — check resolved URLs against denied host patterns
  if (guards.denyHosts && guards.denyHosts.length > 0 && resolvedUrls) {
    for (const url of resolvedUrls) {
      try {
        const hostname = new URL(url).hostname;
        for (const pattern of guards.denyHosts) {
          if (matchHostPattern(hostname, pattern)) {
            failures.push(
              finalizeDiagnostic({
                level: "error",
                code: "GUARD_DENY_HOST",
                message: `Environment ${envId} denies requests to host ${hostname} (matched pattern: ${pattern}).`,
                hint: `Remove ${hostname} from the request URL or update denyHosts in the ${envId} environment.`,
              }),
            );
          }
        }
      } catch {
        // URL parsing failed — skip this URL
      }
    }
  }

  if (failures.length > 0) {
    throw new HttpiError(
      "ENVIRONMENT_GUARD_FAILED",
      `${failures.length} environment guard(s) blocked execution against ${envId}.`,
      {
        exitCode: exitCodes.validationFailure,
        details: failures,
      },
    );
  }
}

function matchHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".staging.example.com"
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

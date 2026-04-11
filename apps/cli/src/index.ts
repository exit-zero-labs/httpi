#!/usr/bin/env node

import type { FlatVariableMap } from "@exit-zero-labs/httpi-contracts";
import {
  describeRequest,
  describeRun,
  explainVariables,
  getSessionState,
  initProject,
  listProjectDefinitions,
  listSessionArtifacts,
  readSessionArtifact,
  resumeSessionRun,
  runRequest,
  runRun,
  validateProject,
} from "@exit-zero-labs/httpi-execution";
import {
  coerceFlatValue,
  exitCodes,
  HttpiError,
} from "@exit-zero-labs/httpi-shared";
import packageJson from "../package.json" with { type: "json" };
import { toCliFailure } from "./error.js";

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  if (
    argv.length === 0 ||
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv[0] === "-h"
  ) {
    printUsage();
    return exitCodes.success;
  }

  if (
    (argv.length === 1 && argv[0] === "version") ||
    argv[0] === "--version" ||
    argv[0] === "-v"
  ) {
    process.stdout.write(`${packageJson.version}\n`);
    return exitCodes.success;
  }

  const parsedArgs = parseArgs(argv);
  const command = parsedArgs.positionals[0];
  const projectRoot = parsedArgs.flags["project-root"]?.[0];
  const envId = parsedArgs.flags.env?.[0];
  const stepId = parsedArgs.flags.step?.[0];
  const overrides = parseInputs(parsedArgs.flags.input ?? []);

  if (command === "init") {
    const result = await initProject(projectRoot ?? process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "list") {
    const listTarget = parsedArgs.positionals[1];
    const result = await listProjectDefinitions({ projectRoot });

    if (listTarget === "requests") {
      writeLines(
        result.requests.map((request) => `${request.id}\t${request.filePath}`),
      );
      return exitCodes.success;
    }

    if (listTarget === "runs") {
      writeLines(result.runs.map((run) => `${run.id}\t${run.filePath}`));
      return exitCodes.success;
    }

    if (listTarget === "envs") {
      writeLines(
        result.envs.map(
          (environment) => `${environment.id}\t${environment.filePath}`,
        ),
      );
      return exitCodes.success;
    }

    if (listTarget === "sessions") {
      writeLines(
        result.sessions.map(
          (session) =>
            `${session.sessionId}\t${session.state}\t${session.runId}\t${session.envId}\t${session.updatedAt}`,
        ),
      );
      return exitCodes.success;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "validate") {
    const result = await validateProject({ projectRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.diagnostics.some((diagnostic) => diagnostic.level === "error")
      ? exitCodes.validationFailure
      : exitCodes.success;
  }

  if (command === "describe") {
    const requestId = parsedArgs.flags.request?.[0];
    const runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "describe");

    if (requestId) {
      const result = await describeRequest(requestId, {
        projectRoot,
        envId,
        overrides,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCodes.success;
    }

    if (runId) {
      const result = await describeRun(runId, {
        projectRoot,
        envId,
        overrides,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCodes.success;
    }

    throw new HttpiError(
      "DESCRIBE_TARGET_REQUIRED",
      requiredTargetMessage("describe", "httpi describe --request ping"),
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "run") {
    const requestId = parsedArgs.flags.request?.[0];
    const runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "run");

    if (requestId) {
      const result = await runRequest(requestId, {
        projectRoot,
        envId,
        overrides,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.session.state === "failed"
        ? exitCodes.executionFailure
        : exitCodes.success;
    }

    if (runId) {
      const result = await runRun(runId, {
        projectRoot,
        envId,
        overrides,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.session.state === "failed"
        ? exitCodes.executionFailure
        : exitCodes.success;
    }

    throw new HttpiError(
      "RUN_TARGET_REQUIRED",
      requiredTargetMessage("run", "httpi run --request ping"),
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "resume") {
    const sessionId = parsedArgs.positionals[1];
    if (!sessionId) {
      throw new HttpiError(
        "SESSION_ID_REQUIRED",
        "Use httpi resume <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const result = await resumeSessionRun(sessionId, { projectRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.session.state === "failed"
      ? exitCodes.executionFailure
      : exitCodes.success;
  }

  if (command === "session") {
    if (parsedArgs.positionals[1] !== "show") {
      throw new HttpiError(
        "SESSION_SUBCOMMAND_REQUIRED",
        "Use httpi session show <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const sessionId = parsedArgs.positionals[2];
    if (!sessionId) {
      throw new HttpiError(
        "SESSION_ID_REQUIRED",
        "Use httpi session show <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const result = await getSessionState(sessionId, { projectRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "artifacts") {
    const subcommand = parsedArgs.positionals[1];
    if (subcommand === "list") {
      const sessionId = parsedArgs.positionals[2];
      if (!sessionId) {
        throw new HttpiError(
          "SESSION_ID_REQUIRED",
          "Use httpi artifacts list <sessionId>.",
          { exitCode: exitCodes.validationFailure },
        );
      }

      const result = await listSessionArtifacts(sessionId, {
        projectRoot,
        stepId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCodes.success;
    }

    if (subcommand === "read") {
      const sessionId = parsedArgs.positionals[2];
      const relativePath = parsedArgs.positionals[3];
      if (!sessionId || !relativePath) {
        throw new HttpiError(
          "ARTIFACT_PATH_REQUIRED",
          "Use httpi artifacts read <sessionId> <relativePath>.",
          { exitCode: exitCodes.validationFailure },
        );
      }

      const result = await readSessionArtifact(sessionId, relativePath, {
        projectRoot,
      });
      if (result.text !== undefined) {
        process.stdout.write(`${result.text}\n`);
        return exitCodes.success;
      }

      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCodes.success;
    }

    throw new HttpiError(
      "ARTIFACTS_SUBCOMMAND_REQUIRED",
      "Use httpi artifacts list <sessionId> or httpi artifacts read <sessionId> <relativePath>.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "explain") {
    if (parsedArgs.positionals[1] !== "variables") {
      throw new HttpiError(
        "EXPLAIN_SUBCOMMAND_REQUIRED",
        "Use httpi explain variables (--request <id> | --run <id>).",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const requestId = parsedArgs.flags.request?.[0];
    const runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "explain variables");
    if (!requestId && !runId) {
      throw new HttpiError(
        "EXPLAIN_TARGET_REQUIRED",
        requiredTargetMessage(
          "explain variables",
          "httpi explain variables --request ping",
        ),
        { exitCode: exitCodes.validationFailure },
      );
    }
    const result = await explainVariables({
      projectRoot,
      requestId,
      runId,
      stepId,
      envId,
      overrides,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  throw new HttpiError(
    "UNKNOWN_COMMAND",
    `Unknown command: ${argv.join(" ")}`,
    { exitCode: exitCodes.validationFailure },
  );
}

function printUsage(): void {
  const usage = `httpi

Usage:
  httpi --help
  httpi --version
  httpi init [--project-root <path>]
  httpi list [requests|runs|envs|sessions] [--project-root <path>]
  httpi validate [--project-root <path>]
  httpi describe --request <id> [--env <id>] [--input key=value]
  httpi describe --run <id> [--env <id>] [--input key=value]
  httpi run --request <id> [--env <id>] [--input key=value]
  httpi run --run <id> [--env <id>] [--input key=value]
  httpi resume <sessionId> [--project-root <path>]
  httpi session show <sessionId> [--project-root <path>]
  httpi artifacts list <sessionId> [--step <id>] [--project-root <path>]
  httpi artifacts read <sessionId> <relativePath> [--project-root <path>]
  httpi explain variables (--request <id> | --run <id>) [--step <id>] [--env <id>] [--input key=value]

List targets:
  requests   list tracked request definitions
  runs       list tracked run definitions
  envs       list tracked environment definitions
  sessions   list persisted runtime sessions

Notes:
  - When --project-root is omitted, httpi discovers the nearest httpi/config.yaml.
  - Outputs are JSON by default, except list subcommands which print tab-separated rows.

Examples:
  httpi list requests
  httpi list sessions
  httpi describe --request ping
  httpi run --run smoke
  httpi artifacts list <sessionId>
  httpi resume <sessionId>
`;

  process.stdout.write(`${usage}\n`);
}

function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Record<string, string[]>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const flagName = argument.slice(2);
    const equalsIndex = flagName.indexOf("=");
    if (equalsIndex !== -1) {
      const normalizedFlagName = flagName.slice(0, equalsIndex);
      const flagValue = flagName.slice(equalsIndex + 1);
      flags[normalizedFlagName] = [
        ...(flags[normalizedFlagName] ?? []),
        flagValue,
      ];
      continue;
    }

    const nextArgument = argv[index + 1];
    if (!nextArgument || nextArgument.startsWith("--")) {
      flags[flagName] = [...(flags[flagName] ?? []), "true"];
      continue;
    }

    flags[flagName] = [...(flags[flagName] ?? []), nextArgument];
    index += 1;
  }

  return {
    positionals,
    flags,
  };
}

function parseInputs(inputAssignments: string[]): FlatVariableMap {
  return inputAssignments.reduce<FlatVariableMap>((result, assignment) => {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex === -1) {
      throw new HttpiError(
        "INVALID_INPUT",
        `Invalid --input value ${assignment}. Expected key=value.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    const key = assignment.slice(0, separatorIndex);
    const rawValue = assignment.slice(separatorIndex + 1);
    if (key.length === 0) {
      throw new HttpiError(
        "INVALID_INPUT",
        `Invalid --input value ${assignment}. Expected key=value.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    result[key] = coerceFlatValue(rawValue);
    return result;
  }, {});
}

function assertSingleTarget(
  requestId: string | undefined,
  runId: string | undefined,
  commandName: string,
): void {
  if (requestId && runId) {
    throw new HttpiError(
      "TARGET_AMBIGUOUS",
      `${commandLabel(commandName)} accepts either --request <id> or --run <id>, not both.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
}

function requiredTargetMessage(commandName: string, example: string): string {
  return `${commandLabel(commandName)} requires either --request <id> or --run <id>.\nExample: ${example}`;
}

function commandLabel(commandName: string): string {
  return `${commandName[0]?.toUpperCase() ?? ""}${commandName.slice(1)} command`;
}

function writeLines(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  try {
    const exitCode = await runCli();
    process.exitCode = exitCode;
  } catch (error) {
    const failure = toCliFailure(error);
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}

void main();

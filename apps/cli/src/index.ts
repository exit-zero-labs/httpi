#!/usr/bin/env node

/**
 * Thin CLI adapter for the shared `runmark` engine.
 *
 * This file should stay focused on argv parsing, command dispatch, terminal
 * formatting, and exit-code mapping. Domain behavior belongs in packages.
 */
import { dirname } from "node:path";
import type {
  CleanableSessionState,
  Diagnostic,
  FlatVariableMap,
} from "@exit-zero-labs/runmark-contracts";
import {
  acceptSnapshotForStep,
  cancelSessionRun,
  cleanProjectRuntime,
  describeRequest,
  describeRun,
  explainVariables,
  exportProjectAudit,
  getSessionState,
  initProject,
  installSignalCancelHandler,
  listProjectDefinitions,
  listSessionArtifacts,
  readSessionArtifact,
  resumeSessionRun,
  runRequest,
  runRun,
  validateProject,
} from "@exit-zero-labs/runmark-execution";
import {
  assertPathWithin,
  coerceFlatValue,
  exitCodes,
  fileExists,
  RunmarkError,
} from "@exit-zero-labs/runmark-shared";
import packageJson from "../package.json" with { type: "json" };
import { formatCliDiagnostics, toCliFailure } from "./error.js";

/** Dispatch one CLI invocation and return the process exit code to use. */
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const helpTopic = resolveHelpTopic(argv);
  if (helpTopic) {
    printHelp(helpTopic);
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

  if (command === "mcp") {
    // Lazy-import so CLI users who never touch MCP don't pay the cost of
    // parsing @modelcontextprotocol/sdk on every `runmark` invocation.
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
    return exitCodes.success;
  }

  if (command === "demo") {
    if (parsedArgs.positionals[1] !== "start") {
      throw new RunmarkError(
        "DEMO_SUBCOMMAND_REQUIRED",
        "Use runmark demo start [--host <host>] [--port <port>].",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const { runDemoServerCommand } = await import("./demo.js");
    await runDemoServerCommand({
      host: parsedArgs.flags.host?.[0],
      port: parseOptionalIntegerFlag(parsedArgs.flags.port?.[0], "--port", {
        minimum: 0,
      }),
    });
    return exitCodes.success;
  }

  if (command === "init") {
    const result = await initProject(projectRoot ?? process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "list") {
    const listTarget = parsedArgs.positionals[1];
    if (
      listTarget !== "requests" &&
      listTarget !== "runs" &&
      listTarget !== "envs" &&
      listTarget !== "sessions"
    ) {
      throw new RunmarkError(
        "LIST_TARGET_REQUIRED",
        "Use runmark list <requests|runs|envs|sessions>.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const result = await listProjectDefinitions({ projectRoot });
    writeDiagnostics(result.diagnostics);

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
  }

  if (command === "validate") {
    const result = await validateProject({ projectRoot });
    writeDiagnostics(result.diagnostics);
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
      writeDiagnostics(result.diagnostics);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.diagnostics.some(
        (diagnostic) => diagnostic.level === "error",
      )
        ? exitCodes.validationFailure
        : exitCodes.success;
    }

    if (runId) {
      const result = await describeRun(runId, {
        projectRoot,
        envId,
        overrides,
      });
      writeDiagnostics(result.diagnostics);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.diagnostics.some(
        (diagnostic) => diagnostic.level === "error",
      )
        ? exitCodes.validationFailure
        : exitCodes.success;
    }

    throw new RunmarkError(
      "DESCRIBE_TARGET_REQUIRED",
      requiredTargetMessage("describe", "runmark describe --request ping"),
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "run") {
    const requestId = parsedArgs.flags.request?.[0];
    const runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "run");
    // Wire SIGINT/SIGTERM so Ctrl-C translates into a cancel marker and the
    // active session transitions to 'interrupted' cleanly.
    installSignalCancelHandler();

    const reporterFlag = parsedArgs.flags.reporter?.[0];

    if (requestId) {
      const result = await runRequest(requestId, {
        projectRoot,
        envId,
        overrides,
      });
      writeDiagnostics(result.diagnostics);
      await maybeWriteReporter(reporterFlag, result);
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
      writeDiagnostics(result.diagnostics);
      await maybeWriteReporter(reporterFlag, result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.session.state === "failed"
        ? exitCodes.executionFailure
        : exitCodes.success;
    }

    throw new RunmarkError(
      "RUN_TARGET_REQUIRED",
      requiredTargetMessage("run", "runmark run --request ping"),
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "snapshot") {
    const sub = parsedArgs.positionals[1];
    if (sub !== "accept") {
      throw new RunmarkError(
        "SNAPSHOT_SUBCOMMAND_REQUIRED",
        "Use runmark snapshot accept <sessionId> --step <stepId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const sessionId = parsedArgs.positionals[2];
    if (!sessionId || !stepId) {
      throw new RunmarkError(
        "SNAPSHOT_ARGS_REQUIRED",
        "Use runmark snapshot accept <sessionId> --step <stepId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const result = await acceptSnapshotForStep(sessionId, stepId, {
      projectRoot,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "cancel") {
    const sessionId = parsedArgs.positionals[1];
    if (!sessionId) {
      throw new RunmarkError(
        "SESSION_ID_REQUIRED",
        "Use runmark cancel <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const reason = parsedArgs.flags.reason?.[0];
    const result = await cancelSessionRun(sessionId, {
      projectRoot,
      ...(reason ? { reason } : {}),
      source: "cli",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "resume") {
    const sessionId = parsedArgs.positionals[1];
    if (!sessionId) {
      throw new RunmarkError(
        "SESSION_ID_REQUIRED",
        "Use runmark resume <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    installSignalCancelHandler();
    const result = await resumeSessionRun(sessionId, { projectRoot });
    writeDiagnostics(result.diagnostics);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.session.state === "failed"
      ? exitCodes.executionFailure
      : exitCodes.success;
  }

  if (command === "session") {
    if (parsedArgs.positionals[1] !== "show") {
      throw new RunmarkError(
        "SESSION_SUBCOMMAND_REQUIRED",
        "Use runmark session show <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const sessionId = parsedArgs.positionals[2];
    if (!sessionId) {
      throw new RunmarkError(
        "SESSION_ID_REQUIRED",
        "Use runmark session show <sessionId>.",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const result = await getSessionState(sessionId, { projectRoot });
    writeDiagnostics(result.diagnostics);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "artifacts") {
    const subcommand = parsedArgs.positionals[1];
    if (subcommand === "list") {
      const sessionId = parsedArgs.positionals[2];
      if (!sessionId) {
        throw new RunmarkError(
          "SESSION_ID_REQUIRED",
          "Use runmark artifacts list <sessionId>.",
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
        throw new RunmarkError(
          "ARTIFACT_PATH_REQUIRED",
          "Use runmark artifacts read <sessionId> <relativePath>.",
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

    throw new RunmarkError(
      "ARTIFACTS_SUBCOMMAND_REQUIRED",
      "Use runmark artifacts list <sessionId> or runmark artifacts read <sessionId> <relativePath>.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (command === "clean") {
    const result = await cleanProjectRuntime({
      projectRoot,
      sessionId: parsedArgs.flags.session?.[0],
      states: parseCleanStates(parsedArgs.flags.state ?? []),
      keepLast: parseOptionalIntegerFlag(
        parsedArgs.flags["keep-last"]?.[0],
        "--keep-last",
        { minimum: 0 },
      ),
      olderThanDays: parseOptionalIntegerFlag(
        parsedArgs.flags["older-than-days"]?.[0],
        "--older-than-days",
        { minimum: 0 },
      ),
      includeReports: hasFlag(parsedArgs.flags, "reports"),
      includeSecrets: hasFlag(parsedArgs.flags, "secrets"),
      dryRun: hasFlag(parsedArgs.flags, "dry-run"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCodes.success;
  }

  if (command === "audit") {
    if (parsedArgs.positionals[1] !== "export") {
      throw new RunmarkError(
        "AUDIT_SUBCOMMAND_REQUIRED",
        "Use runmark audit export [--session <id>] [--output <path>].",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const result = await exportProjectAudit({
      projectRoot,
      sessionId: parsedArgs.flags.session?.[0],
    });
    const outputPath = parsedArgs.flags.output?.[0];
    if (!outputPath) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCodes.success;
    }

    const resolvedOutputPath = await writeJsonOutput(
      result.rootDir,
      outputPath,
      result,
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, outputPath: resolvedOutputPath }, null, 2)}\n`,
    );
    return exitCodes.success;
  }

  if (command === "explain") {
    if (parsedArgs.positionals[1] !== "variables") {
      throw new RunmarkError(
        "EXPLAIN_SUBCOMMAND_REQUIRED",
        "Use runmark explain variables (--request <id> | --run <id>).",
        { exitCode: exitCodes.validationFailure },
      );
    }

    const requestId = parsedArgs.flags.request?.[0];
    const runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "explain variables");
    if (!requestId && !runId) {
      throw new RunmarkError(
        "EXPLAIN_TARGET_REQUIRED",
        requiredTargetMessage(
          "explain variables",
          "runmark explain variables --request ping",
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
    writeDiagnostics(result.diagnostics);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.diagnostics.some((diagnostic) => diagnostic.level === "error")
      ? exitCodes.validationFailure
      : exitCodes.success;
  }

  throw new RunmarkError(
    "UNKNOWN_COMMAND",
    `Unknown command: ${argv.join(" ")}`,
    { exitCode: exitCodes.validationFailure },
  );
}

const helpByTopic: Record<string, string> = {
  global: `runmark

Usage:
  runmark --help
  runmark help <command>
  runmark --version
  runmark demo start [--host <host>] [--port <port>]
  runmark init [--project-root <path>]
  runmark list <requests|runs|envs|sessions> [--project-root <path>]
  runmark validate [--project-root <path>]
  runmark describe --request <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark describe --run <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark run --request <id> [--env <id>] [--input key=value] [--reporter <spec>] [--project-root <path>]
  runmark run --run <id> [--env <id>] [--input key=value] [--reporter <spec>] [--project-root <path>]
  runmark cancel <sessionId> [--reason <text>] [--project-root <path>]
  runmark snapshot accept <sessionId> --step <stepId> [--project-root <path>]
  runmark resume <sessionId> [--project-root <path>]
  runmark session show <sessionId> [--project-root <path>]
  runmark artifacts list <sessionId> [--step <id>] [--project-root <path>]
  runmark artifacts read <sessionId> <relativePath> [--project-root <path>]
  runmark clean [--session <id>] [--state <completed|failed|interrupted>] [--keep-last <n>] [--older-than-days <n>] [--reports] [--secrets] [--dry-run] [--project-root <path>]
  runmark audit export [--session <id>] [--output <path>] [--project-root <path>]
  runmark explain variables (--request <id> | --run <id>) [--step <id>] [--env <id>] [--input key=value] [--project-root <path>]
  runmark mcp

List targets:
  requests   list tracked request definitions
  runs       list tracked run definitions
  envs       list tracked environment definitions
  sessions   list persisted runtime sessions

Notes:
  - When --project-root is omitted, runmark discovers the nearest runmark/config.yaml.
  - Outputs are JSON by default, except list subcommands which print tab-separated rows.
  - Use "runmark help <command>" or "<command> --help" for subcommand-specific flags and examples.

Examples:
  runmark demo start
  runmark init
  runmark run --run smoke
  runmark mcp
  runmark clean --keep-last 5 --reports
  runmark audit export --output runmark/artifacts/audit/latest.json
`,
  demo: `runmark demo start

Usage:
  runmark demo start [--host <host>] [--port <port>]

What it does:
  Starts the bundled local demo API used by the quickstart and example projects.

Defaults:
  --host 127.0.0.1
  --port 4318

Examples:
  runmark demo start
  runmark demo start --port 5000
`,
  init: `runmark init

Usage:
  runmark init [--project-root <path>]

What it does:
  Scaffolds a tracked runmark project with a demo-ready dev env, starter request, starter run, and runtime directory layout.

Examples:
  runmark init
  runmark init --project-root examples/new-project
`,
  list: `runmark list

Usage:
  runmark list <requests|runs|envs|sessions> [--project-root <path>]

Examples:
  runmark list requests
  runmark list sessions --project-root examples/pause-resume
`,
  validate: `runmark validate

Usage:
  runmark validate [--project-root <path>]

What it does:
  Validates tracked YAML definitions, references, and safety rules without sending HTTP.
`,
  describe: `runmark describe

Usage:
  runmark describe --request <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark describe --run <id> [--env <id>] [--input key=value] [--project-root <path>]

What it does:
  Compiles a request or run and prints the resolved shape without executing HTTP.

Examples:
  runmark describe --request ping
  runmark describe --run smoke --env staging
`,
  run: `runmark run

Usage:
  runmark run --request <id> [--env <id>] [--input key=value] [--reporter json[:path]] [--project-root <path>]
  runmark run --run <id> [--env <id>] [--input key=value] [--reporter json[:path]] [--project-root <path>]

Reporter:
  json[:path]  Write the execution result as JSON. Without a path, the default target is runmark/artifacts/reports/run.json under the project root.

Exit codes:
  0 success
  1 execution/assertion failure
  2 validation/configuration failure
  3 unsafe resume or lock conflict
  4 unexpected internal error

Examples:
  runmark run --run smoke
  runmark run --run smoke --reporter json
  runmark run --request ping --input userId=123
`,
  cancel: `runmark cancel

Usage:
  runmark cancel <sessionId> [--reason <text>] [--project-root <path>]

What it does:
  Requests graceful cancellation for a running or paused session.
`,
  snapshot: `runmark snapshot accept

Usage:
  runmark snapshot accept <sessionId> --step <stepId> [--project-root <path>]

What it does:
  Promotes the latest captured response body for one snapshot-backed step into the tracked snapshot file declared by that request.
`,
  resume: `runmark resume

Usage:
  runmark resume <sessionId> [--project-root <path>]

What it does:
  Resumes a paused or failed session after checking for tracked-definition drift and lock conflicts.
`,
  session: `runmark session show

Usage:
  runmark session show <sessionId> [--project-root <path>]

What it does:
  Prints the persisted session state, next step, redacted step outputs, and any drift diagnostics.
`,
  artifacts: `runmark artifacts

Usage:
  runmark artifacts list <sessionId> [--step <id>] [--project-root <path>]
  runmark artifacts read <sessionId> <relativePath> [--project-root <path>]

What it does:
  Lists captured artifact manifest entries or reads one captured artifact with redaction applied.

Examples:
  runmark artifacts list <sessionId>
  runmark artifacts read <sessionId> steps/login/attempt-1/request.json
`,
  clean: `runmark clean

Usage:
  runmark clean [--session <id>] [--state <completed|failed|interrupted>] [--keep-last <n>] [--older-than-days <n>] [--reports] [--secrets] [--dry-run] [--project-root <path>]

What it does:
  Removes terminal runtime session state under runmark/artifacts/ while leaving tracked files untouched.
  Matching session cleanup also removes any local *.secret.json companion files stored with owner-only runtime permissions.

Defaults:
  - cleanable states: completed, failed, interrupted
  - paused, running, and created sessions are preserved

Examples:
  runmark clean
  runmark clean --keep-last 10
  runmark clean --state failed --older-than-days 14 --dry-run
  runmark clean --reports --secrets
`,
  audit: `runmark audit export

Usage:
  runmark audit export [--session <id>] [--output <path>] [--project-root <path>]

What it does:
  Exports a redacted session-and-artifact summary suitable for audit, handoff, or archival review.
  Secret companion files remain local runtime state and are never inlined into the exported audit payload.

Examples:
  runmark audit export
  runmark audit export --session smoke-lx123abc
  runmark audit export --output runmark/artifacts/audit/latest.json
`,
  explain: `runmark explain variables

Usage:
  runmark explain variables --request <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark explain variables --run <id> [--step <id>] [--env <id>] [--input key=value] [--project-root <path>]

What it does:
  Shows effective variable values, provenance, and secret marking without executing HTTP.
`,
  mcp: `runmark mcp

Usage:
  runmark mcp

What it does:
  Starts the stdio MCP server backed by the same execution engine as the CLI.

Important:
  Every MCP tool call must include projectRoot pointing at the repository directory containing runmark/config.yaml.
  Breaking change in 0.5.0: older MCP client configs must now send projectRoot on every tool call. See https://runmark.exitzerolabs.com/reference/changelog/ for migration details.
  `,
};

const localInstallHelpNote = `Tip:
  If runmark is installed repo-locally, prefix these commands with npx (for example: npx runmark run --run smoke).`;

function printHelp(topic: string): void {
  process.stdout.write(
    `${helpByTopic[topic] ?? helpByTopic.global}\n${localInstallHelpNote}\n`,
  );
}

function resolveHelpTopic(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return "global";
  }

  if (argv[0] === "--help" || argv[0] === "-h") {
    return "global";
  }

  if (argv[0] === "help") {
    return normalizeHelpTopic(argv.slice(1));
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    return normalizeHelpTopic(
      argv.filter((argument) => argument !== "--help" && argument !== "-h"),
    );
  }

  return undefined;
}

function normalizeHelpTopic(argv: string[]): string {
  const command = argv[0];
  const subcommand = argv[1];
  if (!command) {
    return "global";
  }

  if (command === "demo" && (subcommand === "start" || subcommand === undefined)) {
    return "demo";
  }
  if (
    command === "snapshot" &&
    (subcommand === "accept" || subcommand === undefined)
  ) {
    return "snapshot";
  }
  if (
    command === "session" &&
    (subcommand === "show" || subcommand === undefined)
  ) {
    return "session";
  }
  if (
    command === "artifacts" &&
    (subcommand === "list" || subcommand === "read" || subcommand === undefined)
  ) {
    return "artifacts";
  }
  if (
    command === "explain" &&
    (subcommand === "variables" || subcommand === undefined)
  ) {
    return "explain";
  }
  if (
    command === "audit" &&
    (subcommand === "export" || subcommand === undefined)
  ) {
    return "audit";
  }

  return command in helpByTopic ? command : "global";
}

// F1: CI reporter. Minimal JSON reporter supported in this slice.
// Format: --reporter json:./path.json  (shorthand `json` writes to runmark/artifacts/reports/run.json)
// Additional formats (junit, tap, github) ship in follow-up work.
/** Write an optional reporter artifact for CI or automation consumers. */
async function maybeWriteReporter(
  spec: string | undefined,
  result: unknown,
): Promise<void> {
  if (!spec) return;
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, resolve: resolvePath } = await import("node:path");
  const [rawFormat, rawPath] = spec.split(":", 2);
  const format = (rawFormat ?? "json").toLowerCase();
  if (format !== "json") {
    process.stderr.write(
      `[runmark] --reporter=${format} is not yet implemented; only 'json' ships in this release. Skipping.\n`,
    );
    return;
  }
  const baseDir = resolveReporterBaseDir(result);
  const target = resolvePath(
    baseDir,
    rawPath && rawPath.length > 0 ? rawPath : "runmark/artifacts/reports/run.json",
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stderr.write(`[runmark] wrote JSON reporter to ${target}\n`);
}

/** Minimal flag parser for the published CLI surface. */
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
      if (booleanFlagNames.has(flagName)) {
        flags[flagName] = [...(flags[flagName] ?? []), "true"];
        continue;
      }

      throw new RunmarkError(
        "FLAG_VALUE_REQUIRED",
        `Flag --${flagName} requires a value. Use --${flagName} ${flagValuePlaceholder(flagName)}.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    flags[flagName] = [...(flags[flagName] ?? []), nextArgument];
    index += 1;
  }

  return {
    positionals,
    flags,
  };
}

const booleanFlagNames = new Set(["dry-run", "reports", "secrets"]);

function flagValuePlaceholder(flagName: string): string {
  switch (flagName) {
    case "session":
    case "env":
    case "request":
    case "run":
      return "<id>";
    case "step":
      return "<stepId>";
    case "output":
    case "project-root":
      return "<path>";
    case "host":
      return "<host>";
    case "port":
      return "<port>";
    case "reason":
      return "<reason>";
    case "reporter":
      return "<format[:path]>";
    case "input":
      return "<key=value>";
    case "state":
      return "<completed|failed|interrupted>";
    case "keep-last":
    case "older-than-days":
      return "<n>";
    default:
      return "<value>";
  }
}

/** Parse repeated `--input key=value` flags into typed flat overrides. */
function parseInputs(inputAssignments: string[]): FlatVariableMap {
  return inputAssignments.reduce<FlatVariableMap>((result, assignment) => {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex === -1) {
      throw new RunmarkError(
        "INVALID_INPUT",
        `Invalid --input value ${assignment}. Expected key=value.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    const key = assignment.slice(0, separatorIndex);
    const rawValue = assignment.slice(separatorIndex + 1);
    if (key.length === 0) {
      throw new RunmarkError(
        "INVALID_INPUT",
        `Invalid --input value ${assignment}. Expected key=value.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    result[key] = coerceFlatValue(rawValue);
    return result;
  }, {});
}

function hasFlag(flags: Record<string, string[]>, flagName: string): boolean {
  return flags[flagName]?.includes("true") ?? false;
}

function parseCleanStates(rawStates: string[]): CleanableSessionState[] | undefined {
  if (rawStates.length === 0) {
    return undefined;
  }

  const parsedStates = rawStates.map((state) => {
    if (
      state === "completed" ||
      state === "failed" ||
      state === "interrupted"
    ) {
      return state;
    }

    throw new RunmarkError(
      "INVALID_CLEAN_STATE",
      `Unsupported --state value ${state}. Use completed, failed, or interrupted.`,
      { exitCode: exitCodes.validationFailure },
    );
  });

  return [...new Set(parsedStates)];
}

function parseOptionalIntegerFlag(
  rawValue: string | undefined,
  flagName: string,
  options: { minimum?: number } = {},
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  if (!/^-?\d+$/.test(rawValue)) {
    throw new RunmarkError(
      "INVALID_INTEGER_FLAG",
      `${flagName} must be an integer.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsedValue)) {
    throw new RunmarkError(
      "INVALID_INTEGER_FLAG",
      `${flagName} must be a safe integer.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (options.minimum !== undefined && parsedValue < options.minimum) {
    throw new RunmarkError(
      "INVALID_INTEGER_FLAG",
      `${flagName} must be at least ${options.minimum}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return parsedValue;
}

async function writeJsonOutput(
  projectRoot: string,
  outputPath: string,
  value: unknown,
): Promise<string> {
  const { lstat, mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, isAbsolute, resolve: resolvePath } = await import("node:path");
  const resolvedOutputPath = isAbsolute(outputPath)
    ? resolvePath(outputPath)
    : resolvePath(projectRoot, outputPath);
  const projectOwnedRoot = await selectProjectOwnedOutputRoot(
    projectRoot,
    resolvedOutputPath,
  );
  await assertOutputDirectoryChainSafe(
    projectOwnedRoot,
    dirname(resolvedOutputPath),
  );
  if (await fileExists(resolvedOutputPath)) {
    const existingOutputStats = await lstat(resolvedOutputPath);
    if (existingOutputStats.isSymbolicLink()) {
      throw new RunmarkError(
        "OUTPUT_PATH_INVALID",
        "Output files must not resolve through a symlink.",
        { exitCode: exitCodes.validationFailure },
      );
    }
  }
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return resolvedOutputPath;
}

async function selectProjectOwnedOutputRoot(
  projectRoot: string,
  outputPath: string,
): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const { resolve: resolvePath } = await import("node:path");
  const candidateRoots = [resolvePath(projectRoot)];
  const realProjectRoot = await realpath(projectRoot);
  if (!candidateRoots.includes(realProjectRoot)) {
    candidateRoots.push(realProjectRoot);
  }

  for (const candidateRoot of candidateRoots) {
    if (isPathWithinRoot(candidateRoot, outputPath)) {
      return candidateRoot;
    }
  }

  throw new RunmarkError(
    "OUTPUT_PATH_INVALID",
    "Output files must stay within the project root.",
    { exitCode: exitCodes.validationFailure },
  );
}

async function assertOutputDirectoryChainSafe(
  projectRoot: string,
  directoryPath: string,
): Promise<void> {
  const { lstat } = await import("node:fs/promises");
  const { relative, resolve: resolvePath, sep } = await import("node:path");
  const relativeDirectoryPath = relative(projectRoot, directoryPath);
  if (!relativeDirectoryPath) {
    return;
  }

  let currentPath = projectRoot;
  for (const segment of relativeDirectoryPath.split(sep).filter(Boolean)) {
    currentPath = resolvePath(currentPath, segment);
    if (!(await fileExists(currentPath))) {
      continue;
    }

    const stats = await lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new RunmarkError(
        "OUTPUT_PATH_INVALID",
        "Output directories must not resolve through a symlink.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    if (!stats.isDirectory()) {
      throw new RunmarkError(
        "OUTPUT_PATH_INVALID",
        `Output directory ${currentPath} must be a directory.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
  }
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  try {
    assertPathWithin(rootPath, candidatePath, {
      code: "OUTPUT_PATH_INVALID",
      message: "Output files must stay within the project root.",
      exitCode: exitCodes.validationFailure,
    });
    return true;
  } catch (error) {
    if (
      error instanceof RunmarkError &&
      error.code === "OUTPUT_PATH_INVALID"
    ) {
      return false;
    }
    throw error;
  }
}

function resolveReporterBaseDir(result: unknown): string {
  if (hasReporterConfigPath(result)) {
    return dirname(dirname(result.session.compiled.configPath));
  }

  return process.cwd();
}

function hasReporterConfigPath(
  result: unknown,
): result is { session: { compiled: { configPath: string } } } {
  if (typeof result !== "object" || result === null || !("session" in result)) {
    return false;
  }
  const session = result.session;
  if (typeof session !== "object" || session === null || !("compiled" in session)) {
    return false;
  }
  const compiled = session.compiled;
  return (
    typeof compiled === "object" &&
    compiled !== null &&
    "configPath" in compiled &&
    typeof compiled.configPath === "string"
  );
}

function assertSingleTarget(
  requestId: string | undefined,
  runId: string | undefined,
  commandName: string,
): void {
  if (requestId && runId) {
    throw new RunmarkError(
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

function writeDiagnostics(diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write(`${formatCliDiagnostics(diagnostics)}\n`);
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

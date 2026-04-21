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
  ExecutionResult,
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
  listEvalDefinitions,
  listProjectDefinitions,
  listSessionArtifacts,
  quickstartProject,
  readSessionArtifact,
  resumeSessionRun,
  runEval,
  runRequest,
  runRun,
  scaffoldDefinition,
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

  if (command === "quickstart") {
    installSignalCancelHandler();
    const host = parsedArgs.flags.host?.[0];
    const portFlag = parseOptionalIntegerFlag(
      parsedArgs.flags.port?.[0],
      "--port",
      { minimum: 0 },
    );
    const result = await quickstartProject({
      projectRoot,
      noDemo: hasFlag(parsedArgs.flags, "no-demo"),
      runId: parsedArgs.flags.run?.[0],
      ...(host !== undefined ? { host } : {}),
      ...(portFlag !== undefined ? { port: portFlag } : {}),
    });
    writeDiagnostics(result.execution.diagnostics);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    writeQuickstartHint(result);
    return result.execution.session.state === "failed"
      ? exitCodes.executionFailure
      : exitCodes.success;
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
    writeStderrHint(
      `✓ runmark initialized at ${result.rootDir}. Next: runmark quickstart`,
    );
    return exitCodes.success;
  }

  if (command === "new") {
    const kindArg = parsedArgs.positionals[1];
    const id = parsedArgs.positionals[2];
    if (!kindArg || !id) {
      throw new RunmarkError(
        "NEW_ARGS_REQUIRED",
        "Use runmark new <request|run|env|block|eval> <id>. For block, pass --block-kind=headers|auth.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    if (
      kindArg !== "request" &&
      kindArg !== "run" &&
      kindArg !== "env" &&
      kindArg !== "block" &&
      kindArg !== "eval"
    ) {
      throw new RunmarkError(
        "NEW_KIND_UNKNOWN",
        `Unknown kind "${kindArg}". Expected one of: request, run, env, block, eval.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
    const blockKind = parsedArgs.flags["block-kind"]?.[0];
    const scaffolded = await scaffoldDefinition({
      kind: kindArg,
      id,
      ...(blockKind ? { blockKind } : {}),
      ...(projectRoot ? { projectRoot } : {}),
    });
    process.stdout.write(`${JSON.stringify(scaffolded, null, 2)}\n`);
    writeStderrHint(
      `✓ scaffolded ${scaffolded.kind} ${scaffolded.id} → ${scaffolded.filePath}`,
    );
    return exitCodes.success;
  }

  if (command === "edit") {
    const id = parsedArgs.positionals[1];
    if (!id) {
      throw new RunmarkError(
        "EDIT_ID_REQUIRED",
        "Use runmark edit <definitionId>. Matches request, run, env, block, or eval ids.",
        { exitCode: exitCodes.validationFailure },
      );
    }
    const definitions = await listProjectDefinitions({
      ...(projectRoot ? { projectRoot } : {}),
    });
    const match = await findDefinitionPath(
      definitions,
      id,
      projectRoot ?? definitions.rootDir,
    );
    if (!match) {
      throw new RunmarkError(
        "EDIT_NOT_FOUND",
        `No tracked definition matches id "${id}". Searched requests, runs, envs, blocks, and evals.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
    process.stdout.write(
      `${JSON.stringify({ id, kind: match.kind, filePath: match.filePath }, null, 2)}\n`,
    );
    const editor = process.env.EDITOR ?? process.env.VISUAL;
    if (editor) {
      const { spawn } = await import("node:child_process");
      const child = spawn(editor, [match.filePath], { stdio: "inherit" });
      const code: number = await new Promise((resolveClose) => {
        child.on("exit", (c) => resolveClose(c ?? 0));
      });
      writeStderrHint(`✓ ${editor} exited with code ${code}`);
      return code === 0 ? exitCodes.success : exitCodes.executionFailure;
    }
    writeStderrHint(
      `Set $EDITOR (or $VISUAL) to auto-open. Path: ${match.filePath}`,
    );
    return exitCodes.success;
  }

  if (command === "lint") {
    // Lint is a CI-facing alias of validate so scripts can pin a stable
    // name; the output intentionally matches validate byte-for-byte.
    const validated = await validateProject({
      ...(projectRoot ? { projectRoot } : {}),
    });
    writeDiagnostics(validated.diagnostics);
    process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
    const hasErrors = validated.diagnostics.some(
      (diagnostic) => diagnostic.level === "error",
    );
    return hasErrors ? exitCodes.validationFailure : exitCodes.success;
  }

  if (command === "eval") {
    const sub = parsedArgs.positionals[1];
    if (sub === "list") {
      const listed = await listEvalDefinitions({
        ...(projectRoot ? { projectRoot } : {}),
      });
      process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
      return exitCodes.success;
    }
    if (sub === "run") {
      const evalId = parsedArgs.positionals[2];
      if (!evalId) {
        throw new RunmarkError(
          "EVAL_ID_REQUIRED",
          "Use runmark eval run <evalId>.",
          { exitCode: exitCodes.validationFailure },
        );
      }
      const result = await runEval(evalId, {
        ...(projectRoot ? { projectRoot } : {}),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      writeStderrHint(
        `eval ${evalId}: ${result.totals.passed}/${result.totals.rows} passed → ${result.artifactsDir}/summary.md`,
      );
      return result.totals.failed > 0
        ? exitCodes.executionFailure
        : exitCodes.success;
    }
    throw new RunmarkError(
      "EVAL_SUBCOMMAND_REQUIRED",
      "Use runmark eval list or runmark eval run <evalId>.",
      { exitCode: exitCodes.validationFailure },
    );
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
    let runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "describe");
    if (!requestId && !runId) {
      runId = await resolveSoleRunId(projectRoot, "describe");
    }

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
    let runId = parsedArgs.flags.run?.[0];
    assertSingleTarget(requestId, runId, "run");
    if (!requestId && !runId) {
      runId = await resolveSoleRunId(projectRoot, "run");
    }
    // Wire SIGINT/SIGTERM so Ctrl-C translates into a cancel marker and the
    // active session transitions to 'interrupted' cleanly.
    installSignalCancelHandler();

    const reporterFlag = parsedArgs.flags.reporter;

    if (requestId) {
      const result = await runRequest(requestId, {
        projectRoot,
        envId,
        overrides,
      });
      writeDiagnostics(result.diagnostics);
      await maybeWriteReporter(reporterFlag, result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      writeRunHint(result, `request ${requestId}`);
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
      writeRunHint(result, `run ${runId}`);
      return result.session.state === "failed"
        ? exitCodes.executionFailure
        : exitCodes.success;
    }

    throw new RunmarkError(
      "RUN_TARGET_REQUIRED",
      requiredTargetMessage("run", "runmark run --run smoke"),
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
    writeRunHint(result, `session ${sessionId}`);
    await maybeWriteReporter(parsedArgs.flags.reporter, result);
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
  runmark quickstart [--no-demo] [--run <id>] [--host <host>] [--port <port>] [--project-root <path>]
  runmark demo start [--host <host>] [--port <port>]
  runmark init [--project-root <path>]
  runmark new <request|run|env|block|eval> <id> [--block-kind headers|auth] [--project-root <path>]
  runmark edit <definitionId> [--project-root <path>]
  runmark lint [--project-root <path>]
  runmark eval list [--project-root <path>]
  runmark eval run <evalId> [--project-root <path>]
  runmark list <requests|runs|envs|sessions> [--project-root <path>]
  runmark validate [--project-root <path>]
  runmark describe --request <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark describe --run <id> [--env <id>] [--input key=value] [--project-root <path>]
  runmark run [--request <id> | --run <id>] [--env <id>] [--input key=value] [--reporter <spec>] [--project-root <path>]
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
  runmark quickstart
  runmark new request ping
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
  quickstart: `runmark quickstart

Usage:
  runmark quickstart [--no-demo] [--run <id>] [--host <host>] [--port <port>] [--project-root <path>]

What it does:
  One-command onboarding: scaffolds a project if needed, starts the bundled demo
  server in-process, runs the project's sole run (or the one named "smoke"), and
  then stops the demo server. Returns the full execution result as JSON on stdout.

Flags:
  --no-demo          Skip starting the bundled demo server (use when your target
                     service is already running).
  --run <id>         Override which run to execute.
  --host <host>      Demo-server bind host (default 127.0.0.1).
  --port <port>      Demo-server port (default 4318).

Examples:
  runmark quickstart
  runmark quickstart --no-demo --run smoke
  runmark quickstart --port 5055
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
  new: `runmark new

Usage:
  runmark new request <id> [--project-root <path>]
  runmark new run <id> [--project-root <path>]
  runmark new env <id> [--project-root <path>]
  runmark new block <id> --block-kind <headers|auth> [--project-root <path>]
  runmark new eval <id> [--project-root <path>]

What it does:
  Scaffolds a tracked YAML definition at the canonical path derived from <id>.
  The scaffolded filename preserves the id verbatim (e.g. "checkout.ping" →
  runmark/requests/checkout.ping.request.yaml) so runmark's path-derived ids
  stay consistent.
  Refuses to overwrite existing files.

Examples:
  runmark new request ping
  runmark new run checkout.smoke
  runmark new env staging
  runmark new block default --block-kind headers
  runmark new eval ping-matrix
`,
  edit: `runmark edit

Usage:
  runmark edit <definitionId> [--project-root <path>]

What it does:
  Resolves <definitionId> to its tracked file path. When $EDITOR (or $VISUAL)
  is set the file is opened immediately; otherwise the path is reported for
  manual opening.

Examples:
  runmark edit ping
  EDITOR=code runmark edit smoke
`,
  lint: `runmark lint

Usage:
  runmark lint [--project-root <path>]

What it does:
  CI-friendly alias of \`runmark validate\`: it walks tracked definitions,
  surfaces diagnostics with file locations, and exits non-zero when any
  diagnostic is an error so CI can fail fast. Prefer \`lint\` in automation
  and \`validate\` in local exploration; the output is identical.

Examples:
  runmark lint
  runmark lint --project-root examples/getting-started
`,
  eval: `runmark eval

Usage:
  runmark eval list [--project-root <path>]
  runmark eval run <evalId> [--project-root <path>]

What it does:
  Runs a tracked eval definition (runmark/evals/<id>.eval.yaml) by fanning
  out one session per dataset row with row-scoped variable overrides. Each
  session still runs its request's own expect assertions. Writes an
  aggregated summary to runmark/artifacts/evals/<evalId>/<ts>/summary.{json,md}.

Datasets:
  Supported kinds are jsonl and csv. Paths are relative to runmark/.

Examples:
  runmark new eval ping-matrix
  runmark eval list
  runmark eval run ping-matrix
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
  runmark run --request <id> [--env <id>] [--input key=value] [--reporter <spec>]... [--project-root <path>]
  runmark run --run <id> [--env <id>] [--input key=value] [--reporter <spec>]... [--project-root <path>]

Reporter (repeatable; spec is <format>[:path]):
  json[:path]     Full execution result as JSON.
  summary[:path]  Human-friendly Markdown summary (also always written to runmark/artifacts/history/<id>/summary.md).
  junit[:path]    JUnit XML for test aggregators.
  tap[:path]      TAP 13 stream.
  github[:path]   GitHub Actions log-command annotations.

Without an explicit path, artifacts are written to runmark/artifacts/reports/<sessionId>.<ext>.

Exit codes:
  0 success
  1 execution/assertion failure
  2 validation/configuration failure
  3 unsafe resume or lock conflict
  4 unexpected internal error

Examples:
  runmark run --run smoke
  runmark run --run smoke --reporter junit --reporter summary
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

// WS4: CI reporter. Supports json, summary (markdown), junit, tap, and github
// formats. Spec is `<format>[:path]`; repeat --reporter to emit multiple.
// Without an explicit path, writes to runmark/artifacts/reports/<defaultBase>.<ext>.
/** Write zero or more reporter artifacts for CI or automation consumers. */
async function maybeWriteReporter(
  specs: string[] | undefined,
  result: unknown,
): Promise<void> {
  if (!specs || specs.length === 0) return;
  if (!isExecutionResultShape(result)) return;
  const typedResult = result as ExecutionResult;
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, resolve: resolvePath } = await import("node:path");
  const { formatReporter } = await import("@exit-zero-labs/runmark-execution");
  const baseDir = resolveReporterBaseDir(typedResult);
  const supportedFormats = new Set<ReporterFormat>([
    "json",
    "summary",
    "junit",
    "tap",
    "github",
  ]);
  const writtenPaths = new Set<string>();
  for (const spec of specs) {
    const [rawFormat, rawPath] = spec.split(":", 2);
    const format = (rawFormat ?? "json").toLowerCase();
    if (!supportedFormats.has(format as ReporterFormat)) {
      process.stderr.write(
        `[runmark] --reporter=${format} is not recognized. Expected one of ${[...supportedFormats].join(", ")}. Skipping.\n`,
      );
      continue;
    }
    const artifact = formatReporter(format as ReporterFormat, typedResult);
    const defaultName = typedResult.session.sessionId ?? artifact.defaultBaseName;
    const target = resolvePath(
      baseDir,
      rawPath && rawPath.length > 0
        ? rawPath
        : `runmark/artifacts/reports/${defaultName}.${artifact.extension}`,
    );
    if (writtenPaths.has(target)) {
      process.stderr.write(
        `[runmark] skipping duplicate --reporter path ${target}; an earlier format already claimed it.\n`,
      );
      continue;
    }
    writtenPaths.add(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content, "utf8");
    process.stderr.write(
      `[runmark] wrote ${artifact.format} reporter to ${target}\n`,
    );
  }
}

type ReporterFormat = "json" | "summary" | "junit" | "tap" | "github";

function isExecutionResultShape(
  value: unknown,
): value is { session: unknown; diagnostics: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "session" in value &&
    "diagnostics" in value
  );
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

const booleanFlagNames = new Set(["dry-run", "reports", "secrets", "no-demo"]);

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

/** Emit a one-line human hint to stderr so stdout stays machine-parseable. */
function writeStderrHint(message: string): void {
  process.stderr.write(`[runmark] ${message}\n`);
}

type DefinitionListEntry = { id: string; filePath: string };
type DefinitionList = {
  requests: DefinitionListEntry[];
  runs: DefinitionListEntry[];
  envs: DefinitionListEntry[];
};
async function findDefinitionPath(
  definitions: DefinitionList,
  id: string,
  projectRoot: string,
): Promise<{ kind: "request" | "run" | "env" | "block" | "eval"; filePath: string } | undefined> {
  const request = definitions.requests.find((entry) => entry.id === id);
  if (request) return { kind: "request", filePath: request.filePath };
  const run = definitions.runs.find((entry) => entry.id === id);
  if (run) return { kind: "run", filePath: run.filePath };
  const env = definitions.envs.find((entry) => entry.id === id);
  if (env) return { kind: "env", filePath: env.filePath };
  const { stat } = await import("node:fs/promises");
  const { resolve: resolvePath } = await import("node:path");
  const scans: Array<{ kind: "block" | "eval"; candidates: string[] }> = [
    {
      kind: "block",
      candidates: [
        `runmark/blocks/headers/${id}.headers.yaml`,
        `runmark/blocks/auth/${id}.auth.yaml`,
        `runmark/blocks/${id}.yaml`,
      ],
    },
    {
      kind: "eval",
      candidates: [`runmark/evals/${id}.eval.yaml`],
    },
  ];
  for (const { kind, candidates } of scans) {
    for (const candidate of candidates) {
      const filePath = resolvePath(projectRoot, candidate);
      try {
        const info = await stat(filePath);
        if (info.isFile()) return { kind, filePath };
      } catch {
        // missing; try next candidate
      }
    }
  }
  return undefined;
}

function writeRunHint(
  result: { session: { sessionId: string; state: string } },
  label: string,
): void {
  const { state, sessionId } = result.session;
  if (state === "completed") {
    writeStderrHint(
      `✓ ${label} completed. Inspect: runmark session show ${sessionId}`,
    );
    return;
  }
  if (state === "paused") {
    writeStderrHint(
      `⏸  ${label} paused. Inspect: runmark session show ${sessionId} — resume: runmark resume ${sessionId}`,
    );
    return;
  }
  if (state === "failed") {
    writeStderrHint(
      `✗ ${label} failed. Inspect: runmark session show ${sessionId} — resume after fix: runmark resume ${sessionId}`,
    );
    return;
  }
  writeStderrHint(`${label} finished with state=${state} (session ${sessionId}).`);
}

function writeQuickstartHint(result: {
  initialized: boolean;
  rootDir: string;
  runId: string;
  demoBaseUrl?: string | undefined;
  execution: { session: { sessionId: string; state: string } };
}): void {
  if (result.initialized) {
    writeStderrHint(`✓ scaffolded project at ${result.rootDir}`);
  }
  if (result.demoBaseUrl) {
    writeStderrHint(`✓ demo server ran on ${result.demoBaseUrl}`);
  }
  writeRunHint(result.execution, `run ${result.runId}`);
}

/**
 * Pick the sole run for a project when the user omits --request/--run.
 *
 * Zero runs or more than one run both exit with a helpful, actionable error so
 * users never have to guess which run the CLI is about to execute.
 */
async function resolveSoleRunId(
  projectRoot: string | undefined,
  commandName: string,
): Promise<string> {
  const listing = await listProjectDefinitions({ projectRoot });
  if (listing.runs.length === 0) {
    throw new RunmarkError(
      "NO_RUNS_DEFINED",
      `No runs found. Create one under runmark/runs/ or pass --request <id>. Example: runmark ${commandName} --run smoke`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (listing.runs.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length-checked above
    const soleRun = listing.runs[0]!;
    writeStderrHint(`Using the only run defined: ${soleRun.id}`);
    return soleRun.id;
  }
  const runList = listing.runs.map((run) => run.id).join(", ");
  throw new RunmarkError(
    "RUN_TARGET_AMBIGUOUS",
    `Multiple runs defined (${runList}). Pass --run <id> to pick one.`,
    { exitCode: exitCodes.validationFailure },
  );
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

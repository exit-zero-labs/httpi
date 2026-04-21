import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDemoServer } from "../../packages/execution/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliEntrypoint = resolve(repoRoot, "apps/cli/dist/index.js");
// MCP is now a subcommand of the CLI; spawn `node apps/cli/dist/index.js mcp`.
const mcpEntrypoint = cliEntrypoint;
const mcpEntrypointArgs = [mcpEntrypoint, "mcp"];
const fixtureProjectRoot = resolve(repoRoot, "examples/pause-resume");

test("CLI validates, preserves parallel artifacts, blocks traversal, resumes, and redacts artifacts", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const validation = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "validate",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRun.code, 0, describeRun.stderr);
    const describedRun = JSON.parse(describeRun.stdout);
    assert.equal(describedRun.steps[1].kind, "parallel");
    assert.equal(describedRun.steps[2].kind, "pause");

    const explainVariables = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "explain",
      "variables",
      "--request",
      "ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(explainVariables.code, 0, explainVariables.stderr);
    const explainedRequest = JSON.parse(explainVariables.stdout);
    assert.equal(
      explainedRequest.variables.find((variable) => variable.name === "baseUrl")
        .source,
      "env",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);

    const pausedExecution = JSON.parse(runResult.stdout);
    assert.equal(pausedExecution.session.state, "paused");
    assert.equal(pausedExecution.session.nextStepId, "touch-user");
    assert.equal(
      pausedExecution.session.stepOutputs.login.sessionValue,
      "[REDACTED]",
    );
    assert.equal(
      pausedExecution.session.stepRecords.login.output.sessionValue,
      "[REDACTED]",
    );

    const sessionId = pausedExecution.session.sessionId;
    const sessionPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.json`,
    );
    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );
    const manifestPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "history",
      sessionId,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(manifest.entries.some((entry) => entry.stepId === "get-user"));
    assert(manifest.entries.some((entry) => entry.stepId === "list-orders"));

    const requestArtifactPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "history",
      sessionId,
      "steps",
      "get-user",
      "attempt-1",
      "request.json",
    );
    const requestArtifact = JSON.parse(
      await readFile(requestArtifactPath, "utf8"),
    );
    assert.equal(requestArtifact.request.headers.authorization, "[REDACTED]");

    const loginBodyPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "history",
      sessionId,
      "steps",
      "login",
      "attempt-1",
      "body.json",
    );
    const loginBody = await readFile(loginBodyPath, "utf8");
    assert.doesNotMatch(loginBody, /secret-token/);
    assert.match(loginBody, /\[REDACTED\]/);

    const persistedSession = await readFile(sessionPath, "utf8");
    const persistedSecretState = await readFile(secretStatePath, "utf8");
    assert.doesNotMatch(persistedSession, /secret-token/);
    assert.doesNotMatch(persistedSession, /swordfish/);
    assert.match(persistedSecretState, /secret-token/);

    const sessionShow = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(sessionShow.code, 0, sessionShow.stderr);
    const shownSession = JSON.parse(sessionShow.stdout);
    assert.equal(shownSession.session.state, "paused");
    assert.equal(shownSession.session.nextStepId, "touch-user");
    assert.equal(
      shownSession.session.stepOutputs.login.sessionValue,
      "[REDACTED]",
    );

    const artifactsList = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "list",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(artifactsList.code, 0, artifactsList.stderr);
    const listedArtifacts = JSON.parse(artifactsList.stdout);
    assert(
      listedArtifacts.artifacts.some(
        (entry) => entry.stepId === "get-user" && entry.kind === "request",
      ),
    );

    const invalidArtifactRead = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "read",
      sessionId,
      "../sessions/not-an-artifact.json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidArtifactRead.code, 2);
    assert.match(invalidArtifactRead.stderr, /Artifact .* was not found/);

    const resumeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumeResult.code, 0, resumeResult.stderr);

    const resumedExecution = JSON.parse(resumeResult.stdout);
    assert.equal(resumedExecution.session.state, "completed");
    assert.equal(
      resumedExecution.session.stepRecords["touch-user"].state,
      "completed",
    );
    assert.equal(state.lastTouchNote, "visited by Ada");

    const resumedPersistedSession = await readFile(sessionPath, "utf8");
    assert.doesNotMatch(resumedPersistedSession, /secret-token/);
    assert.doesNotMatch(resumedPersistedSession, /swordfish/);

    const secondResume = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(secondResume.code, 3);
    assert.match(secondResume.stderr, /cannot be resumed/);

    if (process.platform !== "win32") {
      const sessionStat = await stat(
        join(
          projectRoot,
          "runmark",
          "artifacts",
          "sessions",
          `${sessionId}.json`,
        ),
      );
      const requestDirStat = await stat(
        join(projectRoot, "runmark", "artifacts", "history", sessionId),
      );
      assert.equal(sessionStat.mode & 0o077, 0);
      assert.equal(requestDirStat.mode & 0o077, 0);
    }
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects out-of-sync secret session companion files", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const sessionId = JSON.parse(runResult.stdout).session.sessionId;

    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );
    if (process.platform !== "win32") {
      const secretStateStats = await stat(secretStatePath);
      assert.equal(secretStateStats.mode & 0o777, 0o600);
    }
    const secretState = JSON.parse(await readFile(secretStatePath, "utf8"));
    secretState.stepOutputs = {
      ...(secretState.stepOutputs ?? {}),
      orphanStep: {
        leakedToken: "secret-token",
      },
    };
    await writeFile(secretStatePath, `${JSON.stringify(secretState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const sessionShow = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(sessionShow.code, 2);
    assert.match(sessionShow.stderr, /out of sync/);
    assert.match(sessionShow.stderr, /orphanStep/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects secret session companion files with mismatched schema versions", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const sessionId = JSON.parse(runResult.stdout).session.sessionId;

    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );
    const secretState = JSON.parse(await readFile(secretStatePath, "utf8"));
    secretState.schemaVersion = 999;
    await writeFile(secretStatePath, `${JSON.stringify(secretState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const sessionShow = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(sessionShow.code, 2);
    assert.match(sessionShow.stderr, /schema version 999/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects secret session companion files with mismatched session ids", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const sessionId = JSON.parse(runResult.stdout).session.sessionId;

    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );
    const secretState = JSON.parse(await readFile(secretStatePath, "utf8"));
    secretState.sessionId = "other-session";
    await writeFile(secretStatePath, `${JSON.stringify(secretState, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const sessionShow = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(sessionShow.code, 2);
    assert.match(sessionShow.stderr, /mismatched: found sessionId other-session/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI quickstart scaffolds, runs, and emits a human-friendly stderr hint", async () => {
  // Start our own demo server on an ephemeral port so this test never clashes
  // with the default 4318 port a parallel test run might be holding.
  const { server, baseUrl } = await startDemoServer({ port: 0 });
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-quickstart-"));

  try {
    // Init first so we can pin the env to the ephemeral demo URL, then run
    // quickstart with --no-demo so it reuses the already-running server.
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);
    assert.match(initResult.stderr, /runmark initialized at/);
    assert.match(initResult.stderr, /Next: runmark quickstart/);

    const envPath = join(projectRoot, "runmark", "env", "dev.env.yaml");
    const envYaml = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      envYaml.replace(/baseUrl: .*/, `baseUrl: ${baseUrl}`),
      "utf8",
    );

    const quickstartResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "quickstart",
      "--no-demo",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(quickstartResult.code, 0, quickstartResult.stderr);
    const parsed = JSON.parse(quickstartResult.stdout);
    assert.equal(parsed.runId, "smoke");
    assert.equal(parsed.initialized, false);
    assert.equal(parsed.demoBaseUrl, undefined);
    assert.equal(parsed.execution.session.state, "completed");
    assert.match(quickstartResult.stderr, /run smoke completed/);
    assert.match(quickstartResult.stderr, /runmark session show /);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI run with no target picks the sole run and errors clearly when ambiguous", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-run-sole-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const envPath = join(projectRoot, "runmark", "env", "dev.env.yaml");
    const envYaml = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      envYaml.replace(/baseUrl: .*/, `baseUrl: ${baseUrl}`),
      "utf8",
    );

    const runNoArgs = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runNoArgs.code, 0, runNoArgs.stderr);
    assert.match(runNoArgs.stderr, /Using the only run defined: smoke/);
    const runParsed = JSON.parse(runNoArgs.stdout);
    assert.equal(runParsed.session.state, "completed");

    // Scaffold a second run file so no-args run becomes ambiguous.
    await writeFile(
      join(projectRoot, "runmark", "runs", "other.run.yaml"),
      [
        "kind: run",
        "title: Other",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: ping",
        "    uses: ping",
        "",
      ].join("\n"),
      "utf8",
    );

    const ambiguous = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /Multiple runs defined/);
    assert.match(ambiguous.stderr, /Pass --run <id>/);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI eval scaffolds, runs a JSONL dataset, and writes aggregated summary", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-eval-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const envPath = join(projectRoot, "runmark", "env", "dev.env.yaml");
    const envYaml = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      envYaml.replace(/baseUrl: .*/, `baseUrl: ${baseUrl}`),
      "utf8",
    );

    // Scaffold an eval via the CLI.
    const newEval = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "eval",
      "ping-matrix",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(newEval.code, 0, newEval.stderr);

    // Point the eval at the init-scaffolded smoke run and provide a JSONL dataset.
    const evalPath = join(
      projectRoot,
      "runmark",
      "evals",
      "ping-matrix.eval.yaml",
    );
    await writeFile(
      evalPath,
      [
        "kind: eval",
        "schemaVersion: 1",
        "title: Ping matrix",
        "target:",
        "  run: smoke",
        "env: dev",
        "dataset:",
        "  kind: jsonl",
        "  path: datasets/ping.jsonl",
        "concurrency: 2",
        "",
      ].join("\n"),
      "utf8",
    );
    const datasetDir = join(projectRoot, "runmark", "datasets");
    await mkdir(datasetDir, { recursive: true });
    await writeFile(
      join(datasetDir, "ping.jsonl"),
      [
        JSON.stringify({ baseUrl }),
        JSON.stringify({ baseUrl }),
        JSON.stringify({ baseUrl }),
      ].join("\n"),
      "utf8",
    );

    const listEvals = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "eval",
      "list",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listEvals.code, 0, listEvals.stderr);
    const listed = JSON.parse(listEvals.stdout);
    assert.equal(listed.evals.length, 1);
    assert.equal(listed.evals[0].id, "ping-matrix");
    assert.equal(listed.evals[0].targetKind, "run");
    assert.equal(listed.evals[0].targetId, "smoke");

    const runEvalRes = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "eval",
      "run",
      "ping-matrix",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runEvalRes.code, 0, runEvalRes.stderr);
    const evalResult = JSON.parse(runEvalRes.stdout);
    assert.equal(evalResult.totals.rows, 3);
    assert.equal(evalResult.totals.passed, 3);
    assert.equal(evalResult.totals.failed, 0);
    assert.equal(evalResult.rows.length, 3);
    assert.match(runEvalRes.stderr, /3\/3 passed/);

    const summaryJson = JSON.parse(
      await readFile(join(evalResult.artifactsDir, "summary.json"), "utf8"),
    );
    assert.equal(summaryJson.evalId, "ping-matrix");
    const summaryMd = await readFile(
      join(evalResult.artifactsDir, "summary.md"),
      "utf8",
    );
    assert.match(summaryMd, /# Eval `ping-matrix`/);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI new, edit, and lint scaffold definitions and resolve ids", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-new-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const newRequest = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "request",
      "checkout.ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(newRequest.code, 0, newRequest.stderr);
    const scaffoldInfo = JSON.parse(newRequest.stdout);
    assert.equal(scaffoldInfo.kind, "request");
    assert.equal(scaffoldInfo.id, "checkout.ping");
    const scaffoldedYaml = await readFile(scaffoldInfo.filePath, "utf8");
    assert.match(scaffoldedYaml, /kind: request/);
    assert.match(scaffoldedYaml, /title: Checkout Ping/);
    assert.match(scaffoldInfo.filePath, /checkout\.ping\.request\.yaml$/);

    // Re-running refuses to overwrite.
    const newRequestAgain = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "request",
      "checkout.ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(newRequestAgain.code, 2);
    assert.match(newRequestAgain.stderr, /already exists/);

    // Unknown kind surfaces a documented diagnostic.
    const badKind = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "spaceship",
      "ignored",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(badKind.code, 2);
    assert.match(badKind.stderr, /Unknown kind/);

    // Block without --block-kind is rejected.
    const blockNoKind = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "block",
      "default",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(blockNoKind.code, 2);
    assert.match(blockNoKind.stderr, /block-kind/);

    // edit resolves tracked ids and reports the canonical path.
    const edit = await runNodeProcess(
      process.execPath,
      [cliEntrypoint, "edit", "checkout.ping", "--project-root", projectRoot],
      { env: { ...process.env, EDITOR: "", VISUAL: "" } },
    );
    assert.equal(edit.code, 0, edit.stderr);
    const editInfo = JSON.parse(edit.stdout);
    assert.equal(editInfo.id, "checkout.ping");
    assert.equal(editInfo.kind, "request");
    assert.match(edit.stderr, /Set \$EDITOR/);

    const editMissing = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "edit",
      "does-not-exist",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(editMissing.code, 2);
    assert.match(editMissing.stderr, /No tracked definition/);

    // lint exposes the same diagnostics as validate.
    const lint = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "lint",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(lint.code, 0, lint.stderr);
    const lintPayload = JSON.parse(lint.stdout);
    assert.equal(Array.isArray(lintPayload.diagnostics), true);

    // Scaffold a headers block and an eval, then confirm `edit` resolves both.
    const newBlock = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "block",
      "default",
      "--block-kind",
      "headers",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(newBlock.code, 0, newBlock.stderr);
    const blockInfo = JSON.parse(newBlock.stdout);
    assert.match(blockInfo.filePath, /runmark\/blocks\/headers\/default\.headers\.yaml$/);
    // Scaffolded block must pass `runmark validate` against its live schema.
    const blockLint = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "lint",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(blockLint.code, 0, blockLint.stderr);

    const newEval = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "new",
      "eval",
      "smoke-eval",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(newEval.code, 0, newEval.stderr);

    const editBlock = await runNodeProcess(
      process.execPath,
      [cliEntrypoint, "edit", "default", "--project-root", projectRoot],
      { env: { ...process.env, EDITOR: "", VISUAL: "" } },
    );
    assert.equal(editBlock.code, 0, editBlock.stderr);
    const editBlockInfo = JSON.parse(editBlock.stdout);
    assert.equal(editBlockInfo.kind, "block");
    assert.match(editBlockInfo.filePath, /default\.headers\.yaml$/);

    const editEval = await runNodeProcess(
      process.execPath,
      [cliEntrypoint, "edit", "smoke-eval", "--project-root", projectRoot],
      { env: { ...process.env, EDITOR: "", VISUAL: "" } },
    );
    assert.equal(editEval.code, 0, editEval.stderr);
    const editEvalInfo = JSON.parse(editEval.stdout);
    assert.equal(editEvalInfo.kind, "eval");
    assert.match(editEvalInfo.filePath, /smoke-eval\.eval\.yaml$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI run writes multi-format reporters and always-on summary artifacts", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-reporters-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const envPath = join(projectRoot, "runmark", "env", "dev.env.yaml");
    const envYaml = await readFile(envPath, "utf8");
    await writeFile(
      envPath,
      envYaml.replace(/baseUrl: .*/, `baseUrl: ${baseUrl}`),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--reporter",
      "junit",
      "--reporter",
      "tap",
      "--reporter",
      "summary",
      "--reporter",
      "github",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const execution = JSON.parse(runResult.stdout);
    const sessionId = execution.session.sessionId;

    const reportsDir = join(projectRoot, "runmark", "artifacts", "reports");
    const junitXml = await readFile(
      join(reportsDir, `${sessionId}.xml`),
      "utf8",
    );
    assert.match(junitXml, /<testsuite[^>]*name="smoke"/);
    assert.match(junitXml, /<testcase[^>]*name="ping"/);

    const tap = await readFile(join(reportsDir, `${sessionId}.tap`), "utf8");
    assert.match(tap, /^TAP version 13/);
    assert.match(tap, /\nok 1 - ping/);

    const summaryMd = await readFile(
      join(reportsDir, `${sessionId}.md`),
      "utf8",
    );
    assert.match(summaryMd, /# .* Runmark session /);
    assert.match(summaryMd, /Run: `smoke`/);

    const annotations = await readFile(
      join(reportsDir, `${sessionId}.txt`),
      "utf8",
    );
    // Demo smoke runs clean, so we expect the default no-diagnostics notice.
    assert.match(annotations, /::notice::/);

    // Always-on summary artifacts next to the session manifest.
    const historyDir = join(
      projectRoot,
      "runmark",
      "artifacts",
      "history",
      sessionId,
    );
    const summaryJson = JSON.parse(
      await readFile(join(historyDir, "summary.json"), "utf8"),
    );
    assert.equal(summaryJson.sessionId, sessionId);
    assert.equal(summaryJson.runId, "smoke");
    assert.equal(summaryJson.state, "completed");
    assert.ok(summaryJson.totals.steps >= 1);

    const autoSummaryMd = await readFile(
      join(historyDir, "summary.md"),
      "utf8",
    );
    assert.match(autoSummaryMd, /Runmark session /);
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI init scaffolds schema hints and preserves documented validation exits", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-init-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);
    const initializedProject = JSON.parse(initResult.stdout);
    assert.deepEqual(initializedProject.nextSteps, [
      "Run everything in one command: runmark quickstart",
      "Or manually: in another terminal run `runmark demo start`, then `runmark run --run smoke`",
    ]);

    const configYaml = await readFile(
      join(projectRoot, "runmark", "config.yaml"),
      "utf8",
    );
    const envYaml = await readFile(
      join(projectRoot, "runmark", "env", "dev.env.yaml"),
      "utf8",
    );
    const requestYaml = await readFile(
      join(projectRoot, "runmark", "requests", "ping.request.yaml"),
      "utf8",
    );
    const runYaml = await readFile(
      join(projectRoot, "runmark", "runs", "smoke.run.yaml"),
      "utf8",
    );
    assert.match(
      configYaml,
      /yaml-language-server: \$schema=.*config\.schema\.json/,
    );
    assert.match(
      configYaml,
      /Prefer metadata-only response capture for first runs:/,
    );
    assert.match(configYaml, /responseBody: metadata/);
    assert.match(envYaml, /baseUrl: http:\/\/127\.0\.0\.1:4318/);
    assert.match(
      requestYaml,
      /yaml-language-server: \$schema=.*request\.schema\.json/,
    );
    assert.match(runYaml, /yaml-language-server: \$schema=.*run\.schema\.json/);

    const unknownCommand = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "wat",
    ]);
    assert.equal(unknownCommand.code, 2);
    assert.match(unknownCommand.stderr, /Unknown command/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI exposes help and version discovery, including the `runmark mcp` subcommand", async () => {
  const cliManifest = JSON.parse(
    await readFile(join(repoRoot, "apps", "cli", "package.json"), "utf8"),
  );

  const cliVersion = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "--version",
  ]);
  assert.equal(cliVersion.code, 0, cliVersion.stderr);
  assert.equal(cliVersion.stdout.trim(), cliManifest.version);

  const cliHelp = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "--help",
  ]);
  assert.equal(cliHelp.code, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /runmark --version/);
  assert.match(cliHelp.stdout, /List targets:/);
  // MCP is now a subcommand of the CLI; help must advertise it.
  assert.match(cliHelp.stdout, /runmark mcp/);
  assert.match(cliHelp.stdout, /runmark quickstart/);
  assert.match(cliHelp.stdout, /runmark demo start/);
  assert.match(cliHelp.stdout, /runmark clean/);
  assert.match(cliHelp.stdout, /runmark audit export/);
  assert.match(
    cliHelp.stdout,
    /Examples:\n {2}runmark quickstart\n {2}runmark new request ping\n {2}runmark demo start\n {2}runmark init\n {2}runmark run --run smoke\n {2}runmark mcp/,
  );

  const mcpHelp = await runNodeProcess(process.execPath, [cliEntrypoint, "mcp", "--help"]);
  assert.equal(mcpHelp.code, 0, mcpHelp.stderr);
  assert.match(mcpHelp.stdout, /projectRoot/);
  assert.match(mcpHelp.stdout, /Breaking change in 0\.5\.0/);

  const cleanHelp = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "clean",
    "--help",
  ]);
  assert.equal(cleanHelp.code, 0, cleanHelp.stderr);
  assert.match(cleanHelp.stdout, /runmark clean/);
  assert.match(cleanHelp.stdout, /--older-than-days <n>/);

  const auditHelp = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "audit",
    "export",
    "--help",
  ]);
  assert.equal(auditHelp.code, 0, auditHelp.stderr);
  assert.match(auditHelp.stdout, /runmark audit export/);
  assert.match(auditHelp.stdout, /redacted session-and-artifact summary/i);

  const demoHelp = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "demo",
    "start",
    "--help",
  ]);
  assert.equal(demoHelp.code, 0, demoHelp.stderr);
  assert.match(demoHelp.stdout, /runmark demo start/);
  assert.match(demoHelp.stdout, /--host 127\.0\.0\.1/);
  assert.match(demoHelp.stdout, /--port 4318/);
});

test("CLI demo start serves the bundled onboarding endpoint", async () => {
  const demoServer = await startCliDemoServer();

  try {
    assert.match(demoServer.stdout(), /devPassword=swordfish/);

    const response = await fetch(`${demoServer.baseUrl}/ping`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "runmark-demo",
    });
  } finally {
    await demoServer.stop();
  }
});

test("Demo server returns 400 for invalid JSON payloads", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });

  try {
    for (const body of ["{", "[]", "null", "123", "true", '"string"']) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body,
      });
      assert.equal(response.status, 400, `Expected 400 for payload ${body}`);
      assert.deepEqual(await response.json(), { error: "invalid-json" });
    }
  } finally {
    server.close();
  }
});

test("Demo server treats an empty login body as unauthorized input", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });

  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    server.close();
  }
});

test("Demo server returns 404 for missing resources", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });

  try {
    const basicResponse = await fetch(`${baseUrl}/basic/items/missing-item`, {
      headers: {
        authorization: `Basic ${Buffer.from("admin:swordfish").toString("base64")}`,
      },
    });
    assert.equal(basicResponse.status, 404);
    assert.deepEqual(await basicResponse.json(), { error: "not-found" });

    const commerceResponse = await fetch(`${baseUrl}/commerce/orders/missing-order`, {
      headers: {
        "x-api-key": "commerce-token-secret",
      },
    });
    assert.equal(commerceResponse.status, 404);
    assert.deepEqual(await commerceResponse.json(), { error: "not-found" });
  } finally {
    server.close();
  }
});

test("CLI audit export and clean work against the demo-backed init scaffold", async () => {
  const { server, baseUrl } = await startDemoServer({ port: 0 });
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-demo-init-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const emptyCleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--dry-run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(emptyCleanResult.code, 0, emptyCleanResult.stderr);
    const emptyCleanPayload = JSON.parse(emptyCleanResult.stdout);
    assert.deepEqual(emptyCleanPayload.candidateSessionIds, []);
    assert.deepEqual(emptyCleanPayload.removedSessionIds, []);
    assert.deepEqual(emptyCleanPayload.keptSessionIds, []);
    assert.deepEqual(emptyCleanPayload.skipped, []);

    await writeFile(
      join(projectRoot, "runmark", "env", "dev.env.yaml"),
      `schemaVersion: 1\ntitle: Development\nvalues:\n  baseUrl: ${baseUrl}\n`,
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--reporter",
      "json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const execution = JSON.parse(runResult.stdout);
    const sessionId = execution.session.sessionId;

    const reportPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "reports",
      `${sessionId}.json`,
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.session.sessionId, sessionId);

    const auditResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "export",
      "--session",
      sessionId,
      "--output",
      "audit-summary.json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(auditResult.code, 0, auditResult.stderr);
    const auditPayload = JSON.parse(auditResult.stdout);
    assert.equal(auditPayload.sessions.length, 1);
    assert.equal(auditPayload.sessions[0].sessionId, sessionId);

    const auditFile = JSON.parse(
      await readFile(join(projectRoot, "audit-summary.json"), "utf8"),
    );
    assert.equal(auditFile.sessions[0].sessionId, sessionId);

    const escapedAuditPath = resolve(projectRoot, "..", "escaped-audit-summary.json");
    const invalidAuditResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "export",
      "--session",
      sessionId,
      "--output",
      "../escaped-audit-summary.json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidAuditResult.code, 2);
    assert.match(
      invalidAuditResult.stderr,
      /Output files must stay within the project root\./,
    );
    await assert.rejects(stat(escapedAuditPath), /ENOENT/);

    const cleanDryRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      sessionId,
      "--dry-run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(cleanDryRun.code, 0, cleanDryRun.stderr);
    const dryRunPayload = JSON.parse(cleanDryRun.stdout);
    assert.deepEqual(dryRunPayload.candidateSessionIds, [sessionId]);
    assert.deepEqual(dryRunPayload.removedSessionIds, []);

    const cleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      sessionId,
      "--reports",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(cleanResult.code, 0, cleanResult.stderr);
    const cleanPayload = JSON.parse(cleanResult.stdout);
    assert.deepEqual(cleanPayload.removedSessionIds, [sessionId]);
    assert.equal(cleanPayload.removedReports, true);

    await assert.rejects(
      readFile(
        join(projectRoot, "runmark", "artifacts", "sessions", `${sessionId}.json`),
        "utf8",
      ),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(
        join(projectRoot, "runmark", "artifacts", "history", sessionId, "manifest.json"),
        "utf8",
      ),
      /ENOENT/,
    );
    await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI audit export rejects symlinked output directories", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const externalOutputRoot = await mkdtemp(join(tmpdir(), "runmark-audit-output-"));

  try {
    await runCompletedFixtureSession(projectRoot);
    await symlink(externalOutputRoot, join(projectRoot, "audit-link"));

    const auditResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "export",
      "--output",
      "audit-link/export.json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(auditResult.code, 2);
    assert.match(
      auditResult.stderr,
      /Output directories must not resolve through a symlink\./,
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalOutputRoot, { recursive: true, force: true });
  }
});

test("CLI audit export rejects pre-existing symlinked output files", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const externalOutputRoot = await mkdtemp(join(tmpdir(), "runmark-audit-file-"));

  try {
    await runCompletedFixtureSession(projectRoot);
    const externalOutputPath = join(externalOutputRoot, "audit.json");
    await writeFile(externalOutputPath, "{}\n", "utf8");
    await symlink(externalOutputPath, join(projectRoot, "audit-symlink.json"));

    const auditResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "export",
      "--output",
      "audit-symlink.json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(auditResult.code, 2);
    assert.match(
      auditResult.stderr,
      /Output files must not resolve through a symlink\./,
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalOutputRoot, { recursive: true, force: true });
  }
});

test("CLI clean removes secret companion files with completed sessions", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const sessionId = await runCompletedFixtureSession(projectRoot);
    const sessionPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.json`,
    );
    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );

    await readFile(secretStatePath, "utf8");

    const cleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(cleanResult.code, 0, cleanResult.stderr);
    const cleanPayload = JSON.parse(cleanResult.stdout);
    assert.deepEqual(cleanPayload.removedSessionIds, [sessionId]);

    await assert.rejects(readFile(sessionPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(secretStatePath, "utf8"), /ENOENT/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI clean rejects symlinked session files", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const externalRoot = await mkdtemp(join(tmpdir(), "runmark-clean-symlink-"));

  try {
    const sessionId = await runCompletedFixtureSession(projectRoot);
    const sessionPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.json`,
    );
    const externalSessionPath = join(externalRoot, `${sessionId}.json`);
    await writeFile(externalSessionPath, await readFile(sessionPath, "utf8"), "utf8");
    await rm(sessionPath);
    await symlink(externalSessionPath, sessionPath);

    const cleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(cleanResult.code, 2);
    assert.match(cleanResult.stderr, /must not resolve through a symlink/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("CLI clean honors state filters and retention flags", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const completedOldest = await runCompletedFixtureSession(projectRoot);
    const completedKept = await runCompletedFixtureSession(projectRoot);
    const completedRecent = await runCompletedFixtureSession(projectRoot);
    const interruptedSessionId = await runInterruptedFixtureSession(projectRoot);
    const failedSessionId = await runFailedFixtureSession(projectRoot);
    const pausedSessionId = await runPausedFixtureSession(projectRoot);

    await writeSessionUpdatedAt(
      projectRoot,
      completedOldest,
      "2024-01-01T00:00:00.000Z",
    );
    await writeSessionUpdatedAt(
      projectRoot,
      completedKept,
      "2024-01-02T00:00:00.000Z",
    );

    const cleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--state",
      "completed",
      "--keep-last",
      "1",
      "--older-than-days",
      "1",
      "--dry-run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(cleanResult.code, 0, cleanResult.stderr);

    const cleanPayload = JSON.parse(cleanResult.stdout);
    assert.deepEqual(cleanPayload.candidateSessionIds, [completedOldest]);
    assert(cleanPayload.keptSessionIds.includes(completedKept));
    assert(cleanPayload.keptSessionIds.includes(completedRecent));
    assert(cleanPayload.keptSessionIds.includes(interruptedSessionId));
    assert(cleanPayload.keptSessionIds.includes(failedSessionId));
    assert(cleanPayload.keptSessionIds.includes(pausedSessionId));
    assert(
      cleanPayload.skipped.some(
        (entry) =>
          entry.sessionId === completedKept &&
          /Kept by --keep-last 1\./.test(entry.reason),
      ),
    );
    assert(
      cleanPayload.skipped.some(
        (entry) =>
          entry.sessionId === completedRecent &&
          /newer than the 1-day cutoff/.test(entry.reason),
      ),
    );
    assert(
      cleanPayload.skipped.some(
        (entry) =>
          entry.sessionId === pausedSessionId &&
          /not a cleanable terminal state/.test(entry.reason),
      ),
    );

    const failedCleanResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--state",
      "failed",
      "--dry-run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(failedCleanResult.code, 0, failedCleanResult.stderr);
    const failedCleanPayload = JSON.parse(failedCleanResult.stdout);
    assert.deepEqual(failedCleanPayload.candidateSessionIds, [failedSessionId]);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("MCP exports audit summaries for persisted sessions", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "runmark-audit-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const sessionId = JSON.parse(runResult.stdout).session.sessionId;

    await client.connect(transport);
    const auditTool = await client.callTool({
      name: "export_audit_summary",
      arguments: {
        projectRoot,
        sessionId,
      },
    });

    const auditPayload =
      auditTool.structuredContent ?? JSON.parse(auditTool.content[0].text);
    assert.equal(auditPayload.sessions.length, 1);
    assert.equal(auditPayload.sessions[0].sessionId, sessionId);
    assert.equal(auditPayload.sessions[0].state, "paused");
    assert(auditPayload.sessions[0].artifacts.length > 0);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

test("MCP cleans terminal runtime state with the same retention surface as the CLI", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "runmark-clean-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    const sessionId = await runCompletedFixtureSession(projectRoot);
    const sessionPath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.json`,
    );
    const secretStatePath = join(
      projectRoot,
      "runmark",
      "artifacts",
      "sessions",
      `${sessionId}.secret.json`,
    );

    await readFile(secretStatePath, "utf8");
    await client.connect(transport);

    const dryRunTool = await client.callTool({
      name: "clean_runtime_state",
      arguments: {
        projectRoot,
        sessionId,
        olderThanDays: 0,
        dryRun: true,
      },
    });
    const dryRunPayload =
      dryRunTool.structuredContent ?? JSON.parse(dryRunTool.content[0].text);
    assert.deepEqual(dryRunPayload.candidateSessionIds, [sessionId]);
    assert.deepEqual(dryRunPayload.removedSessionIds, []);

    const cleanTool = await client.callTool({
      name: "clean_runtime_state",
      arguments: {
        projectRoot,
        sessionId,
      },
    });
    const cleanPayload =
      cleanTool.structuredContent ?? JSON.parse(cleanTool.content[0].text);
    assert.deepEqual(cleanPayload.removedSessionIds, [sessionId]);

    await assert.rejects(readFile(sessionPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(secretStatePath, "utf8"), /ENOENT/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

test("CLI and MCP pin documented validation and runtime error contracts", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "runmark-error-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "missing-input.request.yaml",
      ),
      [
        "kind: request",
        "title: Missing input",
        "method: GET",
        'url: "{{baseUrl}}/users/{{userId}}"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "extraction-failure.request.yaml",
      ),
      [
        "kind: request",
        "title: Extraction failure",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "expect:",
        "  status: 200",
        "extract:",
        "  missingValue:",
        "    from: $.missing",
        "    required: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const ambiguousRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "ping",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(ambiguousRun.code, 2);
    assert.match(ambiguousRun.stderr, /either --request <id> or --run <id>/);

    // With the sole-run convenience, `runmark run` with no target now auto-picks
    // when exactly one run exists. The explicit error surface fires when the
    // project has no runs at all or when multiple runs are defined, so scaffold
    // a second run to make the fixture ambiguous and assert the new code-2
    // error message.
    await writeFile(
      join(projectRoot, "runmark", "runs", "other.run.yaml"),
      [
        "kind: run",
        "title: Other",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: ping",
        "    uses: ping",
        "",
      ].join("\n"),
      "utf8",
    );
    const missingRunTarget = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(missingRunTarget.code, 2);
    assert.match(missingRunTarget.stderr, /Multiple runs defined/);
    assert.match(missingRunTarget.stderr, /Pass --run <id>/);

    const demoNoSubcommand = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "demo",
    ]);
    assert.equal(demoNoSubcommand.code, 2);
    assert.match(demoNoSubcommand.stderr, /Use runmark demo start/);

    const auditNoSubcommand = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
    ]);
    assert.equal(auditNoSubcommand.code, 2);
    assert.match(auditNoSubcommand.stderr, /Use runmark audit export/);

    const demoWrongSubcommand = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "demo",
      "list",
    ]);
    assert.equal(demoWrongSubcommand.code, 2);
    assert.match(demoWrongSubcommand.stderr, /Use runmark demo start/);

    const auditWrongSubcommand = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "start",
    ]);
    assert.equal(auditWrongSubcommand.code, 2);
    assert.match(auditWrongSubcommand.stderr, /Use runmark audit export/);

    const listNoTarget = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listNoTarget.code, 2);
    assert.match(
      listNoTarget.stderr,
      /Use runmark list <requests\|runs\|envs\|sessions>\./,
    );

    const listInvalidTarget = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "everything",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listInvalidTarget.code, 2);
    assert.match(
      listInvalidTarget.stderr,
      /Use runmark list <requests\|runs\|envs\|sessions>\./,
    );

    const invalidCleanSession = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      "../not-a-session",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidCleanSession.code, 2);
    assert.match(invalidCleanSession.stderr, /Session ID .* is invalid/);

    const missingAuditSession = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "audit",
      "export",
      "--session",
      "missing-session",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(missingAuditSession.code, 2);
    assert.match(
      missingAuditSession.stderr,
      /Session missing-session was not found\./,
    );

    const missingCleanSessionValue = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--session",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(missingCleanSessionValue.code, 2);
    assert.match(
      missingCleanSessionValue.stderr,
      /Flag --session requires a value\. Use --session <id>\./,
    );

    const invalidCleanState = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--state",
      "running",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidCleanState.code, 2);
    assert.match(
      invalidCleanState.stderr,
      /Unsupported --state value running\. Use completed, failed, or interrupted\./,
    );

    const invalidKeepLast = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--keep-last",
      "abc",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidKeepLast.code, 2);
    assert.match(invalidKeepLast.stderr, /--keep-last must be an integer\./);

    const invalidOlderThanDays = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "clean",
      "--older-than-days",
      "-1",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidOlderThanDays.code, 2);
    assert.match(
      invalidOlderThanDays.stderr,
      /--older-than-days must be at least 0\./,
    );

    const invalidInput = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "ping",
      "--input",
      "bad-assignment",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(invalidInput.code, 2);
    assert.match(invalidInput.stderr, /Invalid --input value/);

    const missingSessionId = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(missingSessionId.code, 2);
    assert.match(missingSessionId.stderr, /Use runmark session show <sessionId>/);

    const unresolvedDescribe = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/missing-input",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(unresolvedDescribe.code, 2);
    assert.match(unresolvedDescribe.stderr, /Unable to resolve userId/);
    assert.match(
      unresolvedDescribe.stderr,
      /missing-input\.request\.yaml:4:\d+: error\[VARIABLE_UNRESOLVED\]/,
    );

    const extractionFailure = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/extraction-failure",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(extractionFailure.code, 1);
    assert.match(
      extractionFailure.stderr,
      /extraction-failure\.request\.yaml:9:\d+: error\[EXTRACTION_FAILED\]/,
    );
    const failedExtraction = JSON.parse(extractionFailure.stdout);
    assert.match(
      failedExtraction.session.failureReason,
      /Required extraction missingValue was not found at \$\.missing\./,
    );
    const extractionDiagnostic = failedExtraction.diagnostics.find(
      (diagnostic) => diagnostic.code === "EXTRACTION_FAILED",
    );
    assert(extractionDiagnostic);
    assert.equal(
      extractionDiagnostic.file,
      "runmark/requests/security/extraction-failure.request.yaml",
    );
    assert.equal(
      extractionDiagnostic.filePath,
      "runmark/requests/security/extraction-failure.request.yaml",
    );
    assert.equal(extractionDiagnostic.line, 9);
    assert.equal(extractionDiagnostic.path, "extract.missingValue.from");

    await client.connect(transport);

    const missingProjectRootTool = await client.callTool({
      name: "list_definitions",
      arguments: {},
    });
    assert.equal(missingProjectRootTool.isError, true);
    assert.match(
      missingProjectRootTool.content[0].text,
      /Input validation error/,
    );
    assert.match(missingProjectRootTool.content[0].text, /projectRoot/);
    assert.equal(missingProjectRootTool.structuredContent, undefined);

    const ambiguousTool = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        requestId: "ping",
        runId: "smoke",
      },
    });
    assert.equal(ambiguousTool.isError, true);
    const ambiguousToolPayload = JSON.parse(ambiguousTool.content[0].text);
    assert.equal(ambiguousToolPayload.code, "RUN_TARGET_AMBIGUOUS");

    const missingToolTarget = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
      },
    });
    assert.equal(missingToolTarget.isError, true);
    const missingToolPayload = JSON.parse(missingToolTarget.content[0].text);
    assert.equal(missingToolPayload.code, "RUN_TARGET_REQUIRED");

    const missingInputTool = await client.callTool({
      name: "describe_request",
      arguments: {
        projectRoot,
        requestId: "security/missing-input",
      },
    });
    assert.equal(missingInputTool.isError, true);
    const missingInputPayload = JSON.parse(missingInputTool.content[0].text);
    assert.deepEqual(missingInputTool.structuredContent, missingInputPayload);
    const missingInputDiagnostic = missingInputPayload.diagnostics.find(
      (diagnostic) => diagnostic.code === "VARIABLE_UNRESOLVED",
    );
    assert(missingInputDiagnostic);
    assert.equal(
      missingInputDiagnostic.file,
      "runmark/requests/security/missing-input.request.yaml",
    );
    assert.equal(
      missingInputDiagnostic.filePath,
      "runmark/requests/security/missing-input.request.yaml",
    );
    assert.equal(missingInputDiagnostic.line, 4);
    assert.equal(missingInputDiagnostic.path, "url");

    const extractionFailureTool = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        requestId: "security/extraction-failure",
      },
    });
    const extractionFailurePayload = JSON.parse(
      extractionFailureTool.content[0].text,
    );
    assert.deepEqual(
      extractionFailureTool.structuredContent,
      extractionFailurePayload,
    );
    const extractionToolDiagnostic = extractionFailurePayload.diagnostics.find(
      (diagnostic) => diagnostic.code === "EXTRACTION_FAILED",
    );
    assert(extractionToolDiagnostic);
    assert.equal(
      extractionToolDiagnostic.file,
      "runmark/requests/security/extraction-failure.request.yaml",
    );
    assert.equal(
      extractionToolDiagnostic.filePath,
      "runmark/requests/security/extraction-failure.request.yaml",
    );
    assert.equal(extractionToolDiagnostic.line, 9);
    assert.equal(extractionToolDiagnostic.path, "extract.missingValue.from");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("canonical pause-resume example tracked YAML files keep schema hints", async () => {
  for (const relativePath of [
    "runmark/config.yaml",
    "runmark/env/dev.env.yaml",
    "runmark/runs/smoke.run.yaml",
    "runmark/requests/ping.request.yaml",
    "runmark/requests/auth/login.request.yaml",
    "runmark/requests/orders/list-orders.request.yaml",
    "runmark/requests/users/get-user.request.yaml",
    "runmark/requests/users/touch-user.request.yaml",
    "runmark/blocks/headers/common/json.yaml",
    "runmark/blocks/auth/common/bearer.yaml",
  ]) {
    const fileContent = await readFile(
      join(fixtureProjectRoot, relativePath),
      "utf8",
    );
    assert.match(
      fileContent,
      /yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/exit-zero-labs\/runmark\/main\/packages\/contracts\/schemas\//,
    );
  }
});

test("CLI list, request execution, step-scoped artifacts, and event logs stay usable", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const listedRequests = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "requests",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listedRequests.code, 0, listedRequests.stderr);
    assert.match(listedRequests.stdout, /^ping\t/m);
    assert.match(listedRequests.stdout, /^auth\/login\t/m);

    const listedRuns = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "runs",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listedRuns.code, 0, listedRuns.stderr);
    assert.match(listedRuns.stdout, /^smoke\t/m);

    const listedEnvs = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "envs",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listedEnvs.code, 0, listedEnvs.stderr);
    assert.match(listedEnvs.stdout, /^dev\t/m);

    const describeRequest = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRequest.code, 0, describeRequest.stderr);
    const describedRequest = JSON.parse(describeRequest.stdout);
    assert.equal(describedRequest.request.url, `${baseUrl}/ping`);

    const requestRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(requestRun.code, 0, requestRun.stderr);
    const requestExecution = JSON.parse(requestRun.stdout);
    assert.equal(requestExecution.session.state, "completed");

    const pausedRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(pausedRun.code, 0, pausedRun.stderr);
    const pausedExecution = JSON.parse(pausedRun.stdout);
    assert.equal(pausedExecution.session.state, "paused");

    const listedSessions = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "sessions",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listedSessions.code, 0, listedSessions.stderr);
    assert.match(
      listedSessions.stdout,
      new RegExp(
        `^${pausedExecution.session.sessionId}\\tpaused\\tsmoke\\tdev\\t`,
        "m",
      ),
    );

    const explainedStep = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "explain",
      "variables",
      "--run",
      "smoke",
      "--step",
      "login",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(explainedStep.code, 0, explainedStep.stderr);
    const explainedLogin = JSON.parse(explainedStep.stdout);
    assert.equal(explainedLogin.targetId, "smoke#login");
    assert.equal(
      explainedLogin.variables.find((variable) => variable.name === "password")
        .secret,
      true,
    );

    const filteredArtifacts = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "list",
      pausedExecution.session.sessionId,
      "--step",
      "get-user",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(filteredArtifacts.code, 0, filteredArtifacts.stderr);
    const scopedArtifacts = JSON.parse(filteredArtifacts.stdout);
    assert(scopedArtifacts.artifacts.length > 0);
    assert(
      scopedArtifacts.artifacts.every(
        (artifact) => artifact.stepId === "get-user",
      ),
    );

    const eventLog = await readFile(
      join(
        projectRoot,
        "runmark",
        "artifacts",
        "history",
        pausedExecution.session.sessionId,
        "events.jsonl",
      ),
      "utf8",
    );
    const eventTypes = eventLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).eventType);
    assert(eventTypes.includes("session.running"));
    assert(eventTypes.includes("step.started"));
    assert(eventTypes.includes("session.paused"));
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI resume reports drift details for changed tracked files", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);

    const pausedExecution = JSON.parse(runResult.stdout);
    const sessionId = pausedExecution.session.sessionId;

    await writeFile(
      join(projectRoot, "runmark", "runs", "smoke.run.yaml"),
      `${await readFile(join(projectRoot, "runmark", "runs", "smoke.run.yaml"), "utf8")}\n# drift\n`,
      "utf8",
    );

    const resumeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumeResult.code, 3);
    assert.match(resumeResult.stderr, /smoke\.run\.yaml/);
    assert.match(resumeResult.stderr, /DEFINITION_DRIFT/);
    assert.match(
      resumeResult.stderr,
      /smoke\.run\.yaml:1:1: error\[DEFINITION_DRIFT\]/,
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI validate prints file-located diagnostics while stdout stays structured", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "runs", "security", "invalid.run.yaml"),
      [
        "kind: run",
        "title: Invalid run",
        "env: missing-env",
        "steps:",
        "  - kind: parallel",
        "    id: invalid-parallel",
        "    steps:",
        "      - kind: pause",
        '        id: "stop-here"',
        '        reason: "not allowed"',
        "",
      ].join("\n"),
      "utf8",
    );

    const validation = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "validate",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(validation.code, 2);
    assert.match(
      validation.stderr,
      /invalid\.run\.yaml:3:1: error\[RUN_ENV_NOT_FOUND\]/,
    );

    const validationResult = JSON.parse(validation.stdout);
    const envDiagnostic = validationResult.diagnostics.find(
      (diagnostic) => diagnostic.code === "RUN_ENV_NOT_FOUND",
    );
    assert(envDiagnostic);
    assert.equal(envDiagnostic.level, "error");
    assert.equal(envDiagnostic.file, "runmark/runs/security/invalid.run.yaml");
    assert.match(envDiagnostic.filePath, /invalid\.run\.yaml$/);
    assert.equal(envDiagnostic.line, 3);
    assert.equal(envDiagnostic.column, 1);
    assert.match(
      envDiagnostic.hint,
      /Create the missing referenced definition or update this reference/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI list prints diagnostics for invalid projects on stderr", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "runs", "security", "invalid.run.yaml"),
      [
        "kind: run",
        "title: Invalid run",
        "env: missing-env",
        "steps:",
        "  - kind: parallel",
        "    id: invalid-parallel",
        "    steps:",
        "      - kind: pause",
        '        id: "stop-here"',
        '        reason: "not allowed"',
        "",
      ].join("\n"),
      "utf8",
    );

    const listResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "list",
      "requests",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(listResult.code, 0);
    assert.match(
      listResult.stderr,
      /invalid\.run\.yaml:3:1: error\[RUN_ENV_NOT_FOUND\]/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI describe and explain surface result diagnostics on stderr", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "secret-warning.request.yaml",
      ),
      [
        "kind: request",
        "title: Secret warning",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "headers:",
        "  authorization: Bearer literal-secret-token",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/secret-warning",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 2);
    assert.match(
      describeResult.stderr,
      /secret-warning\.request\.yaml:6:\d+: error\[SECRET_LITERAL\]/,
    );

    const explainResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "explain",
      "variables",
      "--request",
      "security/secret-warning",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(explainResult.code, 2);
    assert.match(
      explainResult.stderr,
      /secret-warning\.request\.yaml:6:\d+: error\[SECRET_LITERAL\]/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects body file paths that escape runmark/bodies", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "requests", "security", "escape.request.yaml"),
      [
        "kind: request",
        "title: Escape Body Path",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  file: ../env/dev.env.yaml",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/escape",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 2);
    assert.match(
      runResult.stderr,
      /escape\.request\.yaml:6:\d+: error\[BODY_FILE_PATH_INVALID\]/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI and MCP surface body-file template diagnostics with file locations", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");
  const client = new Client(
    { name: "runmark-body-template-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "bodies", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "bodies", "security", "template.json"),
      '{"token":"{{missingToken}}"}\n',
      "utf8",
    );
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "body-template.request.yaml",
      ),
      [
        "kind: request",
        "title: Body Template",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  file: security/template.json",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/body-template",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 2);
    assert.match(
      describeResult.stderr,
      /template\.json:1:1: error\[VARIABLE_UNRESOLVED\]/,
    );

    await client.connect(transport);
    const describedRequest = await client.callTool({
      name: "describe_request",
      arguments: {
        projectRoot,
        requestId: "security/body-template",
      },
    });
    assert.equal(describedRequest.isError, true);
    const describedPayload = JSON.parse(describedRequest.content[0].text);
    assert.deepEqual(describedRequest.structuredContent, describedPayload);
    const bodyDiagnostic = describedPayload.diagnostics.find(
      (diagnostic) => diagnostic.code === "VARIABLE_UNRESOLVED",
    );
    assert(bodyDiagnostic);
    assert.equal(bodyDiagnostic.file, "runmark/bodies/security/template.json");
    assert.equal(
      bodyDiagnostic.filePath,
      "runmark/bodies/security/template.json",
    );
    assert.equal(bodyDiagnostic.line, 1);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI and MCP surface missing body-file diagnostics with file locations", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");
  const client = new Client(
    { name: "runmark-missing-body-file-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "missing-body-file.request.yaml",
      ),
      [
        "kind: request",
        "title: Missing body file",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  file: security/does-not-exist.json",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/missing-body-file",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 2);
    assert.match(
      describeResult.stderr,
      /missing-body-file\.request\.yaml:6:\d+: error\[BODY_FILE_NOT_FOUND\]/,
    );

    await client.connect(transport);
    const describedRequest = await client.callTool({
      name: "describe_request",
      arguments: {
        projectRoot,
        requestId: "security/missing-body-file",
      },
    });
    assert.equal(describedRequest.isError, true);
    const describedPayload = JSON.parse(describedRequest.content[0].text);
    assert.deepEqual(describedRequest.structuredContent, describedPayload);
    const bodyDiagnostic = describedPayload.diagnostics.find(
      (diagnostic) => diagnostic.code === "BODY_FILE_NOT_FOUND",
    );
    assert(bodyDiagnostic);
    assert.equal(
      bodyDiagnostic.file,
      "runmark/requests/security/missing-body-file.request.yaml",
    );
    assert.equal(
      bodyDiagnostic.filePath,
      "runmark/requests/security/missing-body-file.request.yaml",
    );
    assert.equal(bodyDiagnostic.line, 6);
    assert.equal(bodyDiagnostic.path, "body.file");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI and MCP surface nested JSON body diagnostics with exact paths", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");
  const client = new Client(
    { name: "runmark-json-body-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "nested-json.request.yaml",
      ),
      [
        "kind: request",
        "title: Nested JSON",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  json:",
        "    user:",
        "      credentials:",
        '        token: "{{missingToken}}"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/nested-json",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 2);
    assert.match(
      describeResult.stderr,
      /nested-json\.request\.yaml:9:\d+: error\[VARIABLE_UNRESOLVED\]/,
    );

    await client.connect(transport);
    const describedRequest = await client.callTool({
      name: "describe_request",
      arguments: {
        projectRoot,
        requestId: "security/nested-json",
      },
    });
    assert.equal(describedRequest.isError, true);
    const describedPayload = JSON.parse(describedRequest.content[0].text);
    assert.deepEqual(describedRequest.structuredContent, describedPayload);
    const bodyDiagnostic = describedPayload.diagnostics.find(
      (diagnostic) => diagnostic.code === "VARIABLE_UNRESOLVED",
    );
    assert(bodyDiagnostic);
    assert.equal(
      bodyDiagnostic.file,
      "runmark/requests/security/nested-json.request.yaml",
    );
    assert.equal(bodyDiagnostic.path, "body.json.user.credentials.token");
    assert.equal(bodyDiagnostic.line, 9);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects body file symlinks that escape runmark/bodies", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await symlink(
      join(projectRoot, "runmark", "env", "dev.env.yaml"),
      join(projectRoot, "runmark", "bodies", "auth", "linked-env.json"),
    );
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "symlink.request.yaml",
      ),
      [
        "kind: request",
        "title: Symlink Body Path",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  file: auth/linked-env.json",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/symlink",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);
    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.match(failedExecution.session.failureReason, /symlink/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects symlinked runmark/bodies roots", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    const externalBodiesRoot = await mkdtemp(
      join(tmpdir(), "runmark-bodies-root-"),
    );
    await writeFile(
      join(externalBodiesRoot, "payload.json"),
      '{"note":"outside"}\n',
      "utf8",
    );

    await rm(join(projectRoot, "runmark", "bodies"), {
      recursive: true,
      force: true,
    });
    await symlink(externalBodiesRoot, join(projectRoot, "runmark", "bodies"));
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "symlinked-bodies.request.yaml",
      ),
      [
        "kind: request",
        "title: Symlinked Bodies Root",
        "method: POST",
        'url: "{{baseUrl}}/auth/login"',
        "body:",
        "  file: payload.json",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/symlinked-bodies",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 2);
    assert.match(describeResult.stderr, /must not resolve through a symlink/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI resume rejects tracked body file drift", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "bodies", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "runmark", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "bodies", "security", "payload.json"),
      '{"note":"before"}\n',
      "utf8",
    );
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "body-file.request.yaml",
      ),
      [
        "kind: request",
        "title: Body File Drift",
        "method: POST",
        'url: "{{baseUrl}}/body-file"',
        "body:",
        "  file: security/payload.json",
        "  contentType: application/json",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "security", "body-drift.run.yaml"),
      [
        "kind: run",
        "title: Body Drift",
        "env: dev",
        "steps:",
        "  - kind: pause",
        "    id: review-body",
        "    reason: Pause before sending the tracked body file",
        "  - kind: request",
        "    id: send-body",
        "    uses: security/body-file",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "security/body-drift",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const pausedExecution = JSON.parse(runResult.stdout);
    assert.equal(pausedExecution.session.state, "paused");

    await writeFile(
      join(projectRoot, "runmark", "bodies", "security", "payload.json"),
      '{"note":"after"}\n',
      "utf8",
    );

    const resumeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      pausedExecution.session.sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumeResult.code, 3);
    assert.match(resumeResult.stderr, /payload\.json/);
    assert.match(resumeResult.stderr, /DEFINITION_DRIFT/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI resume rejects changed $ENV inputs", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "runmark", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "env-drift.request.yaml",
      ),
      [
        "kind: request",
        "title: Process Env Drift",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "headers:",
        "  # This comment reuses $ENV:API_TOKEN to prove drift lookup ignores comments.",
        '  authorization: "$ENV:API_TOKEN"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "security", "env-drift.run.yaml"),
      [
        "kind: run",
        "title: Env Drift",
        "env: dev",
        "steps:",
        "  - kind: pause",
        "    id: review-env",
        "    reason: Pause before resolving process env input",
        "  - kind: request",
        "    id: send-env",
        "    uses: security/env-drift",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(
      process.execPath,
      [
        cliEntrypoint,
        "run",
        "--run",
        "security/env-drift",
        "--project-root",
        projectRoot,
      ],
      {
        env: {
          API_TOKEN: "before-token",
        },
      },
    );
    assert.equal(runResult.code, 0, runResult.stderr);
    const pausedExecution = JSON.parse(runResult.stdout);
    assert.equal(pausedExecution.session.state, "paused");

    const resumeResult = await runNodeProcess(
      process.execPath,
      [
        cliEntrypoint,
        "resume",
        pausedExecution.session.sessionId,
        "--project-root",
        projectRoot,
      ],
      {
        env: {
          API_TOKEN: "after-token",
        },
      },
    );
    assert.equal(resumeResult.code, 3);
    assert.match(resumeResult.stderr, /PROCESS_ENV_DRIFT/);
    assert.match(resumeResult.stderr, /API_TOKEN/);
    assert.match(
      resumeResult.stderr,
      /env-drift\.request\.yaml:7:\d+: error\[PROCESS_ENV_DRIFT\]/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI validate rejects step ids that collide after artifact path sanitization", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "runmark", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "runs", "security", "colliding.run.yaml"),
      [
        "kind: run",
        "title: Colliding Step Ids",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: user/info",
        "    uses: ping",
        "  - kind: request",
        "    id: user-info",
        "    uses: ping",
        "",
      ].join("\n"),
      "utf8",
    );

    const validation = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "validate",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(validation.code, 2);
    const validationResult = JSON.parse(validation.stdout);
    assert(
      validationResult.diagnostics.some(
        (diagnostic) => diagnostic.code === "STEP_ID_PATH_COLLISION",
      ),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI and MCP surface assertion diagnostics with exact request locations", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "runmark-assertion-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "status-mismatch.request.yaml",
      ),
      [
        "kind: request",
        "title: Status mismatch",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "expect:",
        "  status: 201",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/status-mismatch",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);
    assert.match(
      runResult.stderr,
      /status-mismatch\.request\.yaml:6:\d+: error\[EXPECTATION_FAILED\]/,
    );

    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "failed");
    const cliDiagnostic = execution.diagnostics.find(
      (diagnostic) => diagnostic.code === "EXPECTATION_FAILED",
    );
    assert(cliDiagnostic);
    assert.equal(cliDiagnostic.level, "error");
    assert.match(cliDiagnostic.file, /status-mismatch\.request\.yaml$/);
    assert.equal(cliDiagnostic.line, 6);
    assert.equal(cliDiagnostic.column, 3);
    assert.equal(cliDiagnostic.path, "expect.status");
    assert.match(
      cliDiagnostic.hint,
      /Update the expect block if the contract changed/,
    );

    await client.connect(transport);
    const mcpRun = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        requestId: "security/status-mismatch",
      },
    });
    const mcpExecution = JSON.parse(mcpRun.content[0].text);
    assert.equal(mcpExecution.session.state, "failed");
    assert.deepEqual(mcpRun.structuredContent, mcpExecution);
    const mcpDiagnostic = mcpExecution.diagnostics.find(
      (diagnostic) => diagnostic.code === "EXPECTATION_FAILED",
    );
    assert(mcpDiagnostic);
    assert.equal(mcpDiagnostic.level, "error");
    assert.match(mcpDiagnostic.file, /status-mismatch\.request\.yaml$/);
    assert.equal(mcpDiagnostic.line, 6);
    assert.equal(mcpDiagnostic.column, 3);
    assert.equal(mcpDiagnostic.path, "expect.status");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("MCP resume_session exposes structured drift diagnostics", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "runmark-drift-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);

    const pausedRun = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        runId: "smoke",
      },
    });
    const pausedExecution = JSON.parse(pausedRun.content[0].text);
    assert.equal(pausedExecution.session.state, "paused");

    const sessionId = pausedExecution.session.sessionId;
    await writeFile(
      join(projectRoot, "runmark", "runs", "smoke.run.yaml"),
      `${await readFile(join(projectRoot, "runmark", "runs", "smoke.run.yaml"), "utf8")}\n# drift\n`,
      "utf8",
    );

    const resumed = await client.callTool({
      name: "resume_session",
      arguments: {
        projectRoot,
        sessionId,
      },
    });
    assert.equal(resumed.isError, true);
    const payload = JSON.parse(resumed.content[0].text);
    assert.equal(payload.code, "SESSION_DRIFT_DETECTED");

    const diagnostic = payload.diagnostics.find(
      (entry) => entry.code === "DEFINITION_DRIFT",
    );
    assert(diagnostic);
    assert.equal(diagnostic.level, "error");
    assert.match(diagnostic.file, /smoke\.run\.yaml$/);
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.column, 1);
    assert.match(
      diagnostic.hint,
      /Start a fresh run or revert the tracked file before resuming/,
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects secrets file symlinks", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await rm(join(projectRoot, "runmark", "artifacts", "secrets.yaml"));
    await symlink(
      join(projectRoot, "runmark", "env", "dev.env.yaml"),
      join(projectRoot, "runmark", "artifacts", "secrets.yaml"),
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);
    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.match(failedExecution.session.failureReason, /secrets\.yaml/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI redacts direct overrides in describe output and request artifacts", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "security",
        "override-secret.request.yaml",
      ),
      [
        "kind: request",
        "title: Override Secret",
        "method: GET",
        'url: "{{baseUrl}}/override-secret"',
        "headers:",
        '  x-test-credential: "{{credential}}"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const describeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--request",
      "security/override-secret",
      "--input",
      "credential=topsecret",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeResult.code, 0, describeResult.stderr);
    assert.doesNotMatch(describeResult.stdout, /topsecret/);
    const describedRequest = JSON.parse(describeResult.stdout);
    assert.equal(
      describedRequest.request.headers["x-test-credential"],
      "[REDACTED]",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/override-secret",
      "--input",
      "credential=topsecret",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /topsecret/);
    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.compiled.runInputs.credential, "[REDACTED]");

    const requestArtifact = JSON.parse(
      await readFile(
        join(
          projectRoot,
          "runmark",
          "artifacts",
          "history",
          execution.session.sessionId,
          "steps",
          "request",
          "attempt-1",
          "request.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      requestArtifact.request.headers["x-test-credential"],
      "[REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(requestArtifact), /topsecret/);

    const sessionShow = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      execution.session.sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(sessionShow.code, 0, sessionShow.stderr);
    assert.doesNotMatch(sessionShow.stdout, /topsecret/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("MCP exposes the documented core tools over stdio", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  const client = new Client(
    { name: "runmark-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    for (const toolName of [
      "list_definitions",
      "validate_project",
      "describe_request",
      "describe_run",
      "run_definition",
      "resume_session",
      "get_session_state",
      "list_artifacts",
      "read_artifact",
      "get_stream_chunks",
      "cancel_session",
      "explain_variables",
      "export_audit_summary",
      "clean_runtime_state",
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      assert(tool);
      assert(tool.inputSchema);
      assert(Array.isArray(tool.inputSchema.required));
      assert(tool.inputSchema.required.includes("projectRoot"));
    }

    const definitions = await client.callTool({
      name: "list_definitions",
      arguments: { projectRoot },
    });
    const listedDefinitions = JSON.parse(definitions.content[0].text);
    assert(listedDefinitions.requests.some((request) => request.id === "ping"));
    assert(listedDefinitions.runs.some((run) => run.id === "smoke"));
    assert(
      listedDefinitions.envs.some((environment) => environment.id === "dev"),
    );

    const validation = await client.callTool({
      name: "validate_project",
      arguments: { projectRoot },
    });
    const validationContent = JSON.parse(validation.content[0].text);
    assert.deepEqual(validationContent.diagnostics, []);

    const describeRequest = await client.callTool({
      name: "describe_request",
      arguments: {
        projectRoot,
        requestId: "ping",
      },
    });
    const describedRequest = JSON.parse(describeRequest.content[0].text);
    assert.equal(describedRequest.request.url, `${baseUrl}/ping`);

    const describe = await client.callTool({
      name: "describe_run",
      arguments: {
        projectRoot,
        runId: "smoke",
      },
    });
    const describedRun = JSON.parse(describe.content[0].text);
    assert.equal(describedRun.steps[1].kind, "parallel");

    const explain = await client.callTool({
      name: "explain_variables",
      arguments: {
        projectRoot,
        requestId: "ping",
      },
    });
    const explained = JSON.parse(explain.content[0].text);
    assert.equal(
      explained.variables.find((variable) => variable.name === "baseUrl")
        .source,
      "env",
    );

    const explainedStep = await client.callTool({
      name: "explain_variables",
      arguments: {
        projectRoot,
        runId: "smoke",
        stepId: "login",
      },
    });
    const explainedLogin = JSON.parse(explainedStep.content[0].text);
    assert.equal(explainedLogin.targetId, "smoke#login");
    assert.equal(
      explainedLogin.variables.find((variable) => variable.name === "password")
        .secret,
      true,
    );

    const requestRun = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        requestId: "ping",
      },
    });
    const requestRunContent = JSON.parse(requestRun.content[0].text);
    assert.equal(requestRunContent.session.state, "completed");

    const run = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        runId: "smoke",
      },
    });
    const runContent = JSON.parse(run.content[0].text);
    assert.equal(runContent.session.state, "paused");
    assert.equal(runContent.session.nextStepId, "touch-user");

    const sessionId = runContent.session.sessionId;
    const sessionState = await client.callTool({
      name: "get_session_state",
      arguments: {
        projectRoot,
        sessionId,
      },
    });
    const mcpSession = JSON.parse(sessionState.content[0].text);
    assert.equal(mcpSession.session.state, "paused");
    assert.equal(
      mcpSession.session.stepOutputs.login.sessionValue,
      "[REDACTED]",
    );

    const artifacts = await client.callTool({
      name: "list_artifacts",
      arguments: {
        projectRoot,
        sessionId,
      },
    });
    const listedArtifacts = JSON.parse(artifacts.content[0].text);
    assert(
      listedArtifacts.artifacts.some(
        (entry) => entry.stepId === "get-user" && entry.kind === "request",
      ),
    );

    const scopedArtifacts = await client.callTool({
      name: "list_artifacts",
      arguments: {
        projectRoot,
        sessionId,
        stepId: "get-user",
      },
    });
    const scopedArtifactList = JSON.parse(scopedArtifacts.content[0].text);
    assert(scopedArtifactList.artifacts.length > 0);
    assert(
      scopedArtifactList.artifacts.every(
        (artifact) => artifact.stepId === "get-user",
      ),
    );

    const loginBodyArtifact = listedArtifacts.artifacts.find(
      (entry) => entry.stepId === "login" && entry.kind === "body",
    );
    assert(loginBodyArtifact);
    const loginBody = await client.callTool({
      name: "read_artifact",
      arguments: {
        projectRoot,
        sessionId,
        relativePath: loginBodyArtifact.relativePath,
      },
    });
    const loginBodyContent = JSON.parse(loginBody.content[0].text);
    assert.match(loginBodyContent.text, /\[REDACTED\]/);
    assert.doesNotMatch(loginBodyContent.text, /secret-token/);

    const resumed = await client.callTool({
      name: "resume_session",
      arguments: {
        projectRoot,
        sessionId,
      },
    });
    const resumedContent = JSON.parse(resumed.content[0].text);
    assert.equal(resumedContent.session.state, "completed");
  } finally {
    await client.close();
    await transport.close();
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI preserves secret-taint through parallel extraction and resume", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "session"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "requests", "session", "rotate.request.yaml"),
      [
        "kind: request",
        "title: Rotate Session",
        "method: POST",
        'url: "{{baseUrl}}/session/rotate"',
        "uses:",
        "  headers:",
        "    - common/json",
        "  auth: common/bearer",
        "expect:",
        "  status: 200",
        "extract:",
        "  downstreamValue:",
        "    from: $.data.refreshToken",
        "    required: true",
        "    secret: true",
        "  displayName:",
        "    from: $.profile.name",
        "    required: true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "secret-chain.run.yaml"),
      [
        "kind: run",
        "title: Secret Chain",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: login",
        "    uses: auth/login",
        "    with:",
        "      email: dev@example.com",
        '      password: "{{secrets.devPassword}}"',
        "  - kind: parallel",
        "    id: hydrate",
        "    steps:",
        "      - kind: request",
        "        id: rotate-session",
        "        uses: session/rotate",
        "        with:",
        '          authToken: "{{steps.login.sessionValue}}"',
        "      - kind: request",
        "        id: get-user",
        "        uses: users/get-user",
        "        with:",
        '          authToken: "{{steps.login.sessionValue}}"',
        '          userId: "123"',
        "  - kind: pause",
        "    id: inspect-rotate",
        "    reason: Inspect rotated session before mutation",
        "  - kind: request",
        "    id: touch-user",
        "    uses: users/touch-user",
        "    with:",
        '      authToken: "{{steps.rotate-session.downstreamValue}}"',
        '      userId: "123"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "secret-chain",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);

    const pausedExecution = JSON.parse(runResult.stdout);
    assert.equal(pausedExecution.session.state, "paused");
    assert.equal(
      pausedExecution.session.stepOutputs["rotate-session"].downstreamValue,
      "[REDACTED]",
    );
    assert.equal(
      pausedExecution.session.stepOutputs["rotate-session"].displayName,
      "Ada",
    );

    const sessionId = pausedExecution.session.sessionId;
    const rotateBody = await readFile(
      join(
        projectRoot,
        "runmark",
        "artifacts",
        "history",
        sessionId,
        "steps",
        "rotate-session",
        "attempt-1",
        "body.json",
      ),
      "utf8",
    );
    assert.doesNotMatch(rotateBody, /secondary-secret/);
    assert.match(rotateBody, /\[REDACTED\]/);
    assert.match(rotateBody, /"name":"Ada"/);

    const resumeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumeResult.code, 0, resumeResult.stderr);
    const resumedExecution = JSON.parse(resumeResult.stdout);
    assert.equal(resumedExecution.session.state, "completed");
    assert.equal(state.lastTouchAuthorization, "Bearer secondary-secret");
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI preserves failed session context and redacted artifacts after runtime failure", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await writeFile(
      join(projectRoot, "runmark", "requests", "users", "fail-user.request.yaml"),
      [
        "kind: request",
        "title: Fail user",
        "method: GET",
        'url: "{{baseUrl}}/users/{{userId}}/fail"',
        "uses:",
        "  headers:",
        "    - common/json",
        "  auth: common/bearer",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "failing-chain.run.yaml"),
      [
        "kind: run",
        "title: Failing Chain",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: login",
        "    uses: auth/login",
        "    with:",
        "      email: dev@example.com",
        '      password: "{{secrets.devPassword}}"',
        "  - kind: request",
        "    id: fail-user",
        "    uses: users/fail-user",
        "    with:",
        '      authToken: "{{steps.login.sessionValue}}"',
        '      userId: "123"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "failing-chain",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);

    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.equal(failedExecution.session.nextStepId, "fail-user");
    assert.match(
      failedExecution.session.failureReason,
      /status.*expected.*200.*got.*500/,
    );
    assert.equal(
      failedExecution.session.stepRecords["fail-user"].state,
      "failed",
    );

    const sessionId = failedExecution.session.sessionId;
    const shownSession = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "session",
      "show",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(shownSession.code, 0, shownSession.stderr);
    const shownFailure = JSON.parse(shownSession.stdout);
    assert.equal(shownFailure.session.state, "failed");
    assert.match(
      shownFailure.session.stepRecords["fail-user"].errorMessage,
      /status.*expected.*200.*got.*500/,
    );

    const artifactsList = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "list",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(artifactsList.code, 0, artifactsList.stderr);
    const listedArtifacts = JSON.parse(artifactsList.stdout);
    const failedBodyArtifact = listedArtifacts.artifacts.find(
      (entry) => entry.stepId === "fail-user" && entry.kind === "body",
    );
    assert(failedBodyArtifact);

    const failedBody = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "read",
      sessionId,
      failedBodyArtifact.relativePath,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(failedBody.code, 0, failedBody.stderr);
    assert.doesNotMatch(failedBody.stdout, /secret-token/);
    assert.match(failedBody.stdout, /\[REDACTED\]/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI can explicitly resume a failed session once the dependency recovers", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "users",
        "flaky-user.request.yaml",
      ),
      [
        "kind: request",
        "title: Flaky user",
        "method: GET",
        'url: "{{baseUrl}}/users/{{userId}}/flaky-once"',
        "uses:",
        "  headers:",
        "    - common/json",
        "  auth: common/bearer",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "retry-chain.run.yaml"),
      [
        "kind: run",
        "title: Retry Chain",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: login",
        "    uses: auth/login",
        "    with:",
        "      email: dev@example.com",
        '      password: "{{secrets.devPassword}}"',
        "  - kind: request",
        "    id: flaky-user",
        "    uses: users/flaky-user",
        "    with:",
        '      authToken: "{{steps.login.sessionValue}}"',
        '      userId: "123"',
        "",
      ].join("\n"),
      "utf8",
    );

    const firstRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "retry-chain",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(firstRun.code, 1);
    const failedExecution = JSON.parse(firstRun.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.equal(
      failedExecution.session.stepRecords["flaky-user"].attempts.length,
      1,
    );

    const resumedRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      failedExecution.session.sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumedRun.code, 0, resumedRun.stderr);
    const resumedExecution = JSON.parse(resumedRun.stdout);
    assert.equal(resumedExecution.session.state, "completed");
    assert.equal(resumedExecution.session.failureReason, undefined);
    assert.equal(
      resumedExecution.session.stepRecords["flaky-user"].attempts.length,
      2,
    );
    assert.equal(
      resumedExecution.session.stepRecords["flaky-user"].attempts[0].outcome,
      "failed",
    );
    assert.equal(
      resumedExecution.session.stepRecords["flaky-user"].attempts[1].outcome,
      "success",
    );
    assert.equal(
      resumedExecution.session.stepRecords["flaky-user"].attempts[1].statusCode,
      200,
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI captures truncated binary response artifacts", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    const configPath = join(projectRoot, "runmark", "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "  maxBodyBytes: 1048576",
        "  maxBodyBytes: 4",
      ),
      "utf8",
    );

    await mkdir(join(projectRoot, "runmark", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "requests", "qa", "binary.request.yaml"),
      [
        "kind: request",
        "title: Binary response",
        "method: GET",
        'url: "{{baseUrl}}/binary"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "qa/binary",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const execution = JSON.parse(runResult.stdout);
    const sessionId = execution.session.sessionId;

    const artifactsList = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "list",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(artifactsList.code, 0, artifactsList.stderr);
    const listedArtifacts = JSON.parse(artifactsList.stdout);
    const requestArtifact = listedArtifacts.artifacts.find(
      (artifact) => artifact.stepId === "request" && artifact.kind === "request",
    );
    const bodyArtifact = listedArtifacts.artifacts.find(
      (artifact) => artifact.stepId === "request" && artifact.kind === "body",
    );
    assert(requestArtifact);
    assert(bodyArtifact);
    assert.equal(bodyArtifact.relativePath, "steps/request/attempt-1/body.bin");

    const requestArtifactResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "read",
      sessionId,
      requestArtifact.relativePath,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(requestArtifactResult.code, 0, requestArtifactResult.stderr);
    const binaryRequestArtifact = JSON.parse(requestArtifactResult.stdout);
    assert.equal(binaryRequestArtifact.response.status, 200);
    assert.equal(binaryRequestArtifact.response.bodyBytes, 8);
    assert.equal(binaryRequestArtifact.response.truncated, true);

    const bodyResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "read",
      sessionId,
      bodyArtifact.relativePath,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(bodyResult.code, 0, bodyResult.stderr);
    const bodyPayload = JSON.parse(bodyResult.stdout);
    assert.equal(bodyPayload.contentType, "application/octet-stream");
    assert.equal(bodyPayload.base64, "AAECAw==");
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI surfaces timeout failures for slow requests", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "requests", "qa", "slow.request.yaml"),
      [
        "kind: request",
        "title: Slow request",
        "method: GET",
        'url: "{{baseUrl}}/slow"',
        "timeoutMs: 50",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "qa/slow",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1, runResult.stderr);
    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.match(failedExecution.session.failureReason, /HTTP request failed:/);
    assert.match(
      failedExecution.session.stepRecords.request.attempts[0].errorMessage,
      /HTTP request failed:/,
    );
    const timeoutRequestArtifact = JSON.parse(
      await readFile(
        join(
          projectRoot,
          "runmark",
          "artifacts",
          "history",
          failedExecution.session.sessionId,
          "steps",
          "request",
          "attempt-1",
          "request.json",
        ),
        "utf8",
      ),
    );
    assert.equal(timeoutRequestArtifact.request.url, `${baseUrl}/slow`);
    assert.equal(timeoutRequestArtifact.response.received, false);
    assert.equal(timeoutRequestArtifact.error.code, "HTTP_REQUEST_FAILED");
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI surfaces loopback connection guidance for refused local requests", async () => {
  const closedPort = await allocateUnusedLoopbackPort();
  const projectRoot = await createFixtureProject(`http://127.0.0.1:${closedPort}`);

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "ping",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);
    assert.match(
      runResult.stderr,
      new RegExp(`Cannot connect to http://127\\.0\\.0\\.1:${closedPort}\\.`),
    );
    assert.match(runResult.stderr, /runmark demo start/);

    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.match(
      failedExecution.session.failureReason,
      new RegExp(`Cannot connect to http://127\\.0\\.0\\.1:${closedPort}\\.`),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI and MCP surface invalid timeout diagnostics with source locations", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");
  const client = new Client(
    { name: "runmark-timeout-diagnostic-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcpEntrypointArgs,
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "runmark", "env", "dev.env.yaml"),
      [
        "schemaVersion: 1",
        "title: Development",
        "values:",
        "  baseUrl: http://127.0.0.1:1",
        "  timeoutMs: 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "qa",
        "invalid-timeout.request.yaml",
      ),
      [
        "kind: request",
        "title: Invalid timeout",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "qa/invalid-timeout",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1);
    assert.match(
      runResult.stderr,
      /dev\.env\.yaml:5:\d+: error\[REQUEST_TIMEOUT_INVALID\]/,
    );
    const failedExecution = JSON.parse(runResult.stdout);
    const timeoutDiagnostic = failedExecution.diagnostics.find(
      (diagnostic) => diagnostic.code === "REQUEST_TIMEOUT_INVALID",
    );
    assert(timeoutDiagnostic);
    assert.equal(timeoutDiagnostic.file, "runmark/env/dev.env.yaml");
    assert.equal(timeoutDiagnostic.filePath, "runmark/env/dev.env.yaml");
    assert.equal(timeoutDiagnostic.line, 5);
    assert.equal(timeoutDiagnostic.path, "values.timeoutMs");

    await client.connect(transport);
    const mcpRun = await client.callTool({
      name: "run_definition",
      arguments: {
        projectRoot,
        requestId: "qa/invalid-timeout",
      },
    });
    const mcpExecution = JSON.parse(mcpRun.content[0].text);
    assert.deepEqual(mcpRun.structuredContent, mcpExecution);
    const mcpTimeoutDiagnostic = mcpExecution.diagnostics.find(
      (diagnostic) => diagnostic.code === "REQUEST_TIMEOUT_INVALID",
    );
    assert(mcpTimeoutDiagnostic);
    assert.equal(mcpTimeoutDiagnostic.file, "runmark/env/dev.env.yaml");
    assert.equal(mcpTimeoutDiagnostic.filePath, "runmark/env/dev.env.yaml");
    assert.equal(mcpTimeoutDiagnostic.line, 5);
    assert.equal(mcpTimeoutDiagnostic.path, "values.timeoutMs");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI merges parallel child failures into parent session state", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await mkdir(join(projectRoot, "runmark", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "runmark",
        "requests",
        "qa",
        "get-user-fail.request.yaml",
      ),
      [
        "kind: request",
        "title: Failing user lookup",
        "method: GET",
        'url: "{{baseUrl}}/users/{{userId}}/fail"',
        "uses:",
        "  headers:",
        "    - common/json",
        "  auth: common/bearer",
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "runmark", "runs", "parallel-failure.run.yaml"),
      [
        "kind: run",
        "title: Parallel failure",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: login",
        "    uses: auth/login",
        "    with:",
        "      email: dev@example.com",
        '      password: "{{secrets.devPassword}}"',
        "  - kind: parallel",
        "    id: fetch-context",
        "    steps:",
        "      - kind: request",
        "        id: get-user",
        "        uses: users/get-user",
        "        with:",
        '          authToken: "{{steps.login.sessionValue}}"',
        '          userId: "123"',
        "      - kind: request",
        "        id: get-user-fail",
        "        uses: qa/get-user-fail",
        "        with:",
        '          authToken: "{{steps.login.sessionValue}}"',
        '          userId: "123"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "parallel-failure",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 1, runResult.stderr);
    const failedExecution = JSON.parse(runResult.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.equal(
      failedExecution.session.failureReason,
      "One or more child steps failed.",
    );
    assert.equal(
      failedExecution.session.stepRecords["fetch-context"].state,
      "failed",
    );
    assert.equal(
      failedExecution.session.stepRecords["get-user"].state,
      "completed",
    );
    assert.equal(
      failedExecution.session.stepRecords["get-user-fail"].state,
      "failed",
    );

    const eventLog = await readFile(
      join(
        projectRoot,
        "runmark",
        "artifacts",
        "history",
        failedExecution.session.sessionId,
        "events.jsonl",
      ),
      "utf8",
    );
    const events = eventLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      events.some(
        (event) =>
          event.stepId === "get-user" && event.eventType === "step.completed",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.stepId === "get-user-fail" && event.eventType === "step.failed",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.stepId === "fetch-context" && event.eventType === "step.failed",
      ),
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI resume rejects tracked files swapped to symlinks", async () => {
  if (process.platform === "win32") {
    return;
  }

  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const externalRoot = await mkdtemp(join(tmpdir(), "runmark-drift-symlink-"));

  try {
    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);

    const pausedExecution = JSON.parse(runResult.stdout);
    const sessionId = pausedExecution.session.sessionId;
    const trackedRunPath = join(projectRoot, "runmark", "runs", "smoke.run.yaml");
    const externalRunPath = join(externalRoot, "smoke.run.yaml");
    await writeFile(
      externalRunPath,
      await readFile(trackedRunPath, "utf8"),
      "utf8",
    );
    await rm(trackedRunPath);
    await symlink(externalRunPath, trackedRunPath);

    const resumeResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "resume",
      sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumeResult.code, 3);
    assert.match(resumeResult.stderr, /DEFINITION_PATH_INVALID/);
    assert.match(resumeResult.stderr, /must not resolve through a symlink/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

async function createFixtureProject(baseUrl) {
  const projectRoot = await mkdtemp(join(tmpdir(), "runmark-fixture-"));
  await cp(fixtureProjectRoot, projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "runmark", "env", "dev.env.yaml"),
    `schemaVersion: 1\ntitle: Development\nvalues:\n  baseUrl: ${baseUrl}\n`,
    "utf8",
  );
  await mkdir(join(projectRoot, "runmark", "artifacts"), { recursive: true });
  await writeFile(
    join(projectRoot, "runmark", "artifacts", "secrets.yaml"),
    "devPassword: swordfish\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return projectRoot;
}

async function runPausedFixtureSession(projectRoot) {
  const runResult = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "run",
    "--run",
    "smoke",
    "--project-root",
    projectRoot,
  ]);
  assert.equal(runResult.code, 0, runResult.stderr);
  const execution = JSON.parse(runResult.stdout);
  assert.equal(execution.session.state, "paused");
  return execution.session.sessionId;
}

async function runCompletedFixtureSession(projectRoot) {
  const sessionId = await runPausedFixtureSession(projectRoot);
  const resumeResult = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "resume",
    sessionId,
    "--project-root",
    projectRoot,
  ]);
  assert.equal(resumeResult.code, 0, resumeResult.stderr);
  const resumedExecution = JSON.parse(resumeResult.stdout);
  assert.equal(resumedExecution.session.state, "completed");
  return sessionId;
}

async function runInterruptedFixtureSession(projectRoot) {
  const sessionId = await runPausedFixtureSession(projectRoot);
  const cancelResult = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "cancel",
    sessionId,
    "--project-root",
    projectRoot,
  ]);
  assert.equal(cancelResult.code, 0, cancelResult.stderr);
  const cancelledExecution = JSON.parse(cancelResult.stdout);
  assert.equal(cancelledExecution.state, "interrupted");
  return sessionId;
}

async function runFailedFixtureSession(projectRoot) {
  const runResult = await runNodeProcess(process.execPath, [
    cliEntrypoint,
    "run",
    "--run",
    "smoke",
    "--input",
    "baseUrl=http://127.0.0.1:1",
    "--project-root",
    projectRoot,
  ]);
  assert.equal(runResult.code, 1, runResult.stderr);
  const failedExecution = JSON.parse(runResult.stdout);
  assert.equal(failedExecution.session.state, "failed");
  return failedExecution.session.sessionId;
}

async function writeSessionUpdatedAt(projectRoot, sessionId, updatedAt) {
  const sessionPath = join(
    projectRoot,
    "runmark",
    "artifacts",
    "sessions",
    `${sessionId}.json`,
  );
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  session.updatedAt = updatedAt;
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

async function startMockServer() {
  const state = {
    flakyUserFailuresRemaining: 1,
    lastTouchNote: undefined,
    lastTouchAuthorization: undefined,
  };

  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const authHeader = request.headers.authorization;

    if (request.method === "GET" && requestUrl.pathname === "/ping") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/binary") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
      });
      response.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/slow") {
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 200);
      });
      if (!response.destroyed) {
        writeJson(response, 200, { ok: true });
      }
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/override-secret"
    ) {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/auth/login") {
      const body = JSON.parse(bodyText);
      assert.equal(body.email, "dev@example.com");
      assert.equal(body.password, "swordfish");
      writeJson(response, 200, { token: "secret-token" });
      return;
    }

    if (
      authHeader !== "Bearer secret-token" &&
      authHeader !== "Bearer secondary-secret"
    ) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/session/rotate"
    ) {
      writeJson(response, 200, {
        data: {
          refreshToken: "secondary-secret",
        },
        profile: {
          name: "Ada",
        },
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/users/123") {
      writeJson(response, 200, { name: "Ada" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/users/123/fail") {
      writeJson(response, 500, {
        error: "upstream-failure",
        echoedToken: "secret-token",
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/users/123/flaky-once"
    ) {
      if (state.flakyUserFailuresRemaining > 0) {
        state.flakyUserFailuresRemaining -= 1;
        writeJson(response, 500, {
          error: "transient-upstream-failure",
          echoedToken: "secret-token",
        });
        return;
      }

      writeJson(response, 200, { name: "Ada" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/orders") {
      writeJson(response, 200, { orders: [{ id: "ord_1" }] });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/users/123/touch"
    ) {
      const body = JSON.parse(bodyText);
      state.lastTouchNote = body.note;
      state.lastTouchAuthorization = authHeader;
      writeJson(response, 200, { touched: true });
      return;
    }

    writeJson(response, 404, { error: "not-found" });
  });

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock server address.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
  };
}

async function allocateUnusedLoopbackPort() {
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.listen(0, "127.0.0.1", (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(undefined);
    });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;

  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(undefined);
    });
  });

  return port;
}

function runNodeProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function startCliDemoServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliEntrypoint, "demo", "start", "--port", "0"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const baseUrlMatch = stdout.match(/\[runmark demo\] listening on (http:\/\/[^\s]+)/);
      if (settled || !baseUrlMatch) {
        return;
      }
      settled = true;
      resolvePromise({
        baseUrl: baseUrlMatch[1],
        stdout: () => stdout,
        stderr: () => stderr,
        stop: () =>
          new Promise((resolveStop) => {
            child.once("close", () => resolveStop());
            child.kill("SIGINT");
          }),
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        rejectPromise(
          new Error(
            `Demo server exited before becoming ready (code ${code ?? "unknown"}).\n${stderr}`,
          ),
        );
      }
    });
  });
}

function readRequestBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolvePromise(body);
    });
    request.on("error", rejectPromise);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

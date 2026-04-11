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

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliEntrypoint = resolve(repoRoot, "apps/cli/dist/index.js");
const mcpEntrypoint = resolve(repoRoot, "apps/mcp/dist/index.js");
const fixtureProjectRoot = resolve(
  repoRoot,
  "testing/httpi/fixtures/basic-project",
);

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
    const manifestPath = join(
      projectRoot,
      ".httpi",
      "responses",
      sessionId,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(manifest.entries.some((entry) => entry.stepId === "get-user"));
    assert(manifest.entries.some((entry) => entry.stepId === "list-orders"));

    const requestSummaryPath = join(
      projectRoot,
      ".httpi",
      "responses",
      sessionId,
      "steps",
      "get-user",
      "attempt-1",
      "request.summary.json",
    );
    const requestSummary = JSON.parse(
      await readFile(requestSummaryPath, "utf8"),
    );
    assert.equal(requestSummary.headers.authorization, "[REDACTED]");

    const loginBodyPath = join(
      projectRoot,
      ".httpi",
      "responses",
      sessionId,
      "steps",
      "login",
      "attempt-1",
      "body.json",
    );
    const loginBody = await readFile(loginBodyPath, "utf8");
    assert.doesNotMatch(loginBody, /secret-token/);
    assert.match(loginBody, /\[REDACTED\]/);

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
        (entry) =>
          entry.stepId === "get-user" && entry.kind === "request.summary",
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
        join(projectRoot, ".httpi", "sessions", `${sessionId}.json`),
      );
      const responseDirStat = await stat(
        join(projectRoot, ".httpi", "responses", sessionId),
      );
      assert.equal(sessionStat.mode & 0o077, 0);
      assert.equal(responseDirStat.mode & 0o077, 0);
    }
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI init scaffolds schema hints and preserves documented validation exits", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-init-"));

  try {
    const initResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "init",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(initResult.code, 0, initResult.stderr);

    const configYaml = await readFile(
      join(projectRoot, "httpi", "config.yaml"),
      "utf8",
    );
    const requestYaml = await readFile(
      join(projectRoot, "httpi", "requests", "ping.request.yaml"),
      "utf8",
    );
    const runYaml = await readFile(
      join(projectRoot, "httpi", "runs", "smoke.run.yaml"),
      "utf8",
    );
    assert.match(
      configYaml,
      /yaml-language-server: \$schema=.*config\.schema\.json/,
    );
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

test("CLI and MCP expose help and version discovery surfaces", async () => {
  const cliManifest = JSON.parse(
    await readFile(join(repoRoot, "apps", "cli", "package.json"), "utf8"),
  );
  const mcpManifest = JSON.parse(
    await readFile(join(repoRoot, "apps", "mcp", "package.json"), "utf8"),
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
  assert.match(cliHelp.stdout, /httpi --version/);
  assert.match(cliHelp.stdout, /List targets:/);

  const mcpVersion = await runNodeProcess(process.execPath, [
    mcpEntrypoint,
    "--version",
  ]);
  assert.equal(mcpVersion.code, 0, mcpVersion.stderr);
  assert.equal(mcpVersion.stdout.trim(), mcpManifest.version);

  const mcpHelp = await runNodeProcess(process.execPath, [
    mcpEntrypoint,
    "--help",
  ]);
  assert.equal(mcpHelp.code, 0, mcpHelp.stderr);
  assert.match(mcpHelp.stdout, /run_definition/);
  assert.match(mcpHelp.stdout, /docs\/agent-guide\.md/);
});

test("CLI and MCP pin documented validation and runtime error contracts", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);
  const client = new Client(
    { name: "httpi-error-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntrypoint],
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe",
  });

  try {
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "httpi",
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
        "httpi",
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

    const missingRunTarget = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(missingRunTarget.code, 2);
    assert.match(
      missingRunTarget.stderr,
      /Run command requires either --request <id> or --run <id>\./,
    );
    assert.match(missingRunTarget.stderr, /Example: httpi run --request ping/);

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
    assert.match(missingSessionId.stderr, /Use httpi session show <sessionId>/);

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

    const extractionFailure = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--request",
      "security/extraction-failure",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(extractionFailure.code, 1);
    const failedExtraction = JSON.parse(extractionFailure.stdout);
    assert.match(
      failedExtraction.session.failureReason,
      /Required extraction missingValue was not found at \$\.missing\./,
    );

    await client.connect(transport);

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
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("fixture project tracked YAML files keep schema hints", async () => {
  for (const relativePath of [
    "httpi/config.yaml",
    "httpi/env/dev.env.yaml",
    "httpi/runs/smoke.run.yaml",
    "httpi/requests/ping.request.yaml",
    "httpi/requests/auth/login.request.yaml",
    "httpi/requests/orders/list-orders.request.yaml",
    "httpi/requests/users/get-user.request.yaml",
    "httpi/requests/users/touch-user.request.yaml",
    "httpi/blocks/headers/common/json.yaml",
    "httpi/blocks/auth/common/bearer.yaml",
  ]) {
    const fileContent = await readFile(
      join(fixtureProjectRoot, relativePath),
      "utf8",
    );
    assert.match(
      fileContent,
      /yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/exit-zero-labs\/httpi\/main\/packages\/contracts\/schemas\//,
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
        ".httpi",
        "responses",
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
      join(projectRoot, "httpi", "runs", "smoke.run.yaml"),
      `${await readFile(join(projectRoot, "httpi", "runs", "smoke.run.yaml"), "utf8")}\n# drift\n`,
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
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects body file paths that escape httpi/bodies", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "requests", "security", "escape.request.yaml"),
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
    assert.match(runResult.stderr, /must stay within httpi\/bodies/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI rejects body file symlinks that escape httpi/bodies", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await symlink(
      join(projectRoot, "httpi", "env", "dev.env.yaml"),
      join(projectRoot, "httpi", "bodies", "auth", "linked-env.json"),
    );
    await writeFile(
      join(
        projectRoot,
        "httpi",
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

test("CLI rejects symlinked httpi/bodies roots", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    const externalBodiesRoot = await mkdtemp(
      join(tmpdir(), "httpi-bodies-root-"),
    );
    await writeFile(
      join(externalBodiesRoot, "payload.json"),
      '{"note":"outside"}\n',
      "utf8",
    );

    await rm(join(projectRoot, "httpi", "bodies"), {
      recursive: true,
      force: true,
    });
    await symlink(externalBodiesRoot, join(projectRoot, "httpi", "bodies"));
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "httpi",
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
    await mkdir(join(projectRoot, "httpi", "bodies", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "httpi", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "bodies", "security", "payload.json"),
      '{"note":"before"}\n',
      "utf8",
    );
    await writeFile(
      join(
        projectRoot,
        "httpi",
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
      join(projectRoot, "httpi", "runs", "security", "body-drift.run.yaml"),
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
      join(projectRoot, "httpi", "bodies", "security", "payload.json"),
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
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await mkdir(join(projectRoot, "httpi", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "httpi",
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
        '  authorization: "$ENV:API_TOKEN"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "httpi", "runs", "security", "env-drift.run.yaml"),
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI validate rejects step ids that collide after artifact path sanitization", async () => {
  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await mkdir(join(projectRoot, "httpi", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "runs", "security", "colliding.run.yaml"),
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

test("CLI rejects secrets file symlinks", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await createFixtureProject("http://127.0.0.1:1");

  try {
    await rm(join(projectRoot, ".httpi", "secrets.yaml"));
    await symlink(
      join(projectRoot, "httpi", "env", "dev.env.yaml"),
      join(projectRoot, ".httpi", "secrets.yaml"),
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
    await mkdir(join(projectRoot, "httpi", "requests", "security"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "httpi",
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

    const requestSummary = JSON.parse(
      await readFile(
        join(
          projectRoot,
          ".httpi",
          "responses",
          execution.session.sessionId,
          "steps",
          "request",
          "attempt-1",
          "request.summary.json",
        ),
        "utf8",
      ),
    );
    assert.equal(requestSummary.headers["x-test-credential"], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestSummary), /topsecret/);

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
    { name: "httpi-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntrypoint],
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
      "explain_variables",
    ]) {
      assert(tools.tools.some((tool) => tool.name === toolName));
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
        (entry) =>
          entry.stepId === "get-user" && entry.kind === "request.summary",
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
    await mkdir(join(projectRoot, "httpi", "requests", "session"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "requests", "session", "rotate.request.yaml"),
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
      join(projectRoot, "httpi", "runs", "secret-chain.run.yaml"),
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
        ".httpi",
        "responses",
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
      join(projectRoot, "httpi", "requests", "users", "fail-user.request.yaml"),
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
      join(projectRoot, "httpi", "runs", "failing-chain.run.yaml"),
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
      /Expected status 200 but received 500/,
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
      /Expected status 200 but received 500/,
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
        "httpi",
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
      join(projectRoot, "httpi", "runs", "retry-chain.run.yaml"),
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
    const configPath = join(projectRoot, "httpi", "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "  maxBodyBytes: 1048576",
        "  maxBodyBytes: 4",
      ),
      "utf8",
    );

    await mkdir(join(projectRoot, "httpi", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "requests", "qa", "binary.request.yaml"),
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
    const responseMetadataArtifact = listedArtifacts.artifacts.find(
      (artifact) =>
        artifact.stepId === "request" && artifact.kind === "response.meta",
    );
    const bodyArtifact = listedArtifacts.artifacts.find(
      (artifact) => artifact.stepId === "request" && artifact.kind === "body",
    );
    assert(responseMetadataArtifact);
    assert(bodyArtifact);
    assert.equal(bodyArtifact.relativePath, "steps/request/attempt-1/body.bin");

    const responseMetadataResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "artifacts",
      "read",
      sessionId,
      responseMetadataArtifact.relativePath,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(responseMetadataResult.code, 0, responseMetadataResult.stderr);
    const responseMetadata = JSON.parse(responseMetadataResult.stdout);
    assert.equal(responseMetadata.status, 200);
    assert.equal(responseMetadata.bodyBytes, 8);
    assert.equal(responseMetadata.truncated, true);

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
    await mkdir(join(projectRoot, "httpi", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "requests", "qa", "slow.request.yaml"),
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
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI merges parallel child failures into parent session state", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createFixtureProject(baseUrl);

  try {
    await mkdir(join(projectRoot, "httpi", "requests", "qa"), {
      recursive: true,
    });
    await writeFile(
      join(
        projectRoot,
        "httpi",
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
      join(projectRoot, "httpi", "runs", "parallel-failure.run.yaml"),
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
        ".httpi",
        "responses",
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
  const externalRoot = await mkdtemp(join(tmpdir(), "httpi-drift-symlink-"));

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
    const trackedRunPath = join(projectRoot, "httpi", "runs", "smoke.run.yaml");
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
  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-fixture-"));
  await cp(fixtureProjectRoot, projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "httpi", "env", "dev.env.yaml"),
    `schemaVersion: 1\ntitle: Development\nvalues:\n  baseUrl: ${baseUrl}\n`,
    "utf8",
  );
  await mkdir(join(projectRoot, ".httpi"), { recursive: true });
  await writeFile(
    join(projectRoot, ".httpi", "secrets.yaml"),
    "devPassword: swordfish\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return projectRoot;
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

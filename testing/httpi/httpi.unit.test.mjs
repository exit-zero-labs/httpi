import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toCliFailure } from "../../apps/cli/testing.js";
import { loadProjectFiles } from "../../packages/definitions/dist/index.js";
import { initProject } from "../../packages/execution/dist/index.js";
import {
  collectVariableExplanations,
  extractStepOutputs,
  redactSessionForOutput,
  resolveTemplateValue,
} from "../../packages/execution/testing.js";
import {
  appendDiagnosticPath,
  toDisplayDiagnosticFile,
} from "../../packages/contracts/dist/index.js";
import { executeHttpRequest } from "../../packages/http/dist/index.js";
import {
  acquireSessionLock,
  appendSessionEvent,
  createSessionRecord,
  ensureRuntimePaths,
  readSession,
  releaseSessionLock,
  writeStepArtifacts,
} from "../../packages/runtime/dist/index.js";
import {
  exitCodes,
  HttpiError,
  redactedValue,
} from "../../packages/shared/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const fixtureProjectRoot = resolve(repoRoot, "examples/pause-resume");

test("explicit and path-derived secret extracts stay tainted", () => {
  const outputs = extractStepOutputs(
    {
      request: {
        extract: {
          sessionValue: {
            from: "$.token",
            required: true,
            secret: true,
          },
          refreshAlias: {
            from: "$.meta.refreshToken",
            required: true,
          },
          publicName: {
            from: "$.name",
            required: true,
          },
        },
      },
    },
    {
      response: {
        bodyText: JSON.stringify({
          token: "secret-token",
          meta: {
            refreshToken: "refresh-token",
          },
          name: "Ada",
        }),
      },
    },
  );

  assert.deepEqual(outputs.values, {
    sessionValue: "secret-token",
    refreshAlias: "refresh-token",
    publicName: "Ada",
  });
  assert.deepEqual(outputs.secretOutputKeys, ["refreshAlias", "sessionValue"]);
});

test("step secret outputs stay secret during interpolation and explanation", () => {
  const context = createResolutionContext();

  const resolvedSecret = resolveTemplateValue(
    "{{steps.login.sessionValue}}",
    context,
  );
  assert.equal(resolvedSecret.value, "secret-token");
  assert.deepEqual(resolvedSecret.secretValues, ["secret-token"]);

  const resolvedPublic = resolveTemplateValue(
    "{{steps.login.userName}}",
    context,
  );
  assert.equal(resolvedPublic.value, "Ada");
  assert.deepEqual(resolvedPublic.secretValues, []);

  const variables = collectVariableExplanations(context);
  assert.equal(findVariable(variables, "authToken").secret, true);
  assert.equal(findVariable(variables, "note").secret, false);
  assert.equal(
    findVariable(variables, "steps.login.sessionValue").secret,
    true,
  );
  assert.equal(findVariable(variables, "steps.login.userName").secret, false);
});

test("direct overrides stay secret during interpolation and session redaction", () => {
  const context = createResolutionContext();
  context.compiled.source = "request";
  context.compiled.runInputs = {
    credential: "topsecret",
  };
  context.compiled.overrideKeys = ["credential"];
  context.step.with = {
    credential: "topsecret",
  };

  const resolvedOverride = resolveTemplateValue("{{credential}}", context);
  assert.equal(resolvedOverride.value, "topsecret");
  assert.deepEqual(resolvedOverride.secretValues, ["topsecret"]);

  const variables = collectVariableExplanations(context);
  assert.equal(findVariable(variables, "credential").source, "override");
  assert.equal(findVariable(variables, "credential").secret, true);

  const redactedSession = redactSessionForOutput({
    schemaVersion: 1,
    sessionId: "request_123",
    source: "request",
    runId: "ping",
    envId: "dev",
    state: "created",
    compiled: {
      ...context.compiled,
      steps: [
        {
          ...context.step,
          with: {
            credential: "topsecret",
          },
        },
      ],
    },
    stepRecords: {},
    stepOutputs: {},
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  });
  assert.equal(redactedSession.compiled.runInputs.credential, redactedValue);
  assert.equal(
    redactedSession.compiled.steps[0].with.credential,
    redactedValue,
  );
});

test("session output redaction honors secret output metadata", () => {
  const redactedSession = redactSessionForOutput({
    schemaVersion: 1,
    sessionId: "run_123",
    source: "run",
    runId: "smoke",
    envId: "dev",
    state: "paused",
    nextStepId: "touch-user",
    compiled: {
      schemaVersion: 1,
      source: "run",
      runId: "smoke",
      envId: "dev",
      sourceFilePath: "/tmp/httpi/runs/smoke.run.yaml",
      configPath: "/tmp/httpi/config.yaml",
      configHash: "config-hash",
      configDefaults: {},
      capture: {
        requestSummary: true,
        responseMetadata: true,
        responseBody: "full",
        maxBodyBytes: 1024,
        redactHeaders: ["authorization"],
      },
      envPath: "/tmp/httpi/env/dev.env.yaml",
      envHash: "env-hash",
      envValues: {},
      runInputs: {},
      overrideKeys: [],
      definitionHashes: {},
      steps: [
        {
          kind: "request",
          id: "touch-user",
          requestId: "users/touch-user",
          with: {
            authToken: "{{steps.login.sessionValue}}",
          },
          request: {
            requestId: "users/touch-user",
            filePath: "/tmp/httpi/requests/users/touch-user.request.yaml",
            hash: "request-hash",
            method: "POST",
            url: "{{baseUrl}}/users/{{userId}}/touch",
            defaults: {
              apiToken: "secret-token",
              label: "safe",
            },
            headers: {},
            headerBlocks: [],
            expect: {},
            extract: {},
          },
        },
      ],
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    stepRecords: {
      login: {
        stepId: "login",
        kind: "request",
        requestId: "auth/login",
        state: "completed",
        attempts: [],
        output: {
          sessionValue: "secret-token",
          userName: "Ada",
        },
        secretOutputKeys: ["sessionValue"],
      },
    },
    stepOutputs: {
      login: {
        sessionValue: "secret-token",
        userName: "Ada",
      },
    },
    artifactManifestPath: "/tmp/.httpi/responses/run_123/manifest.json",
    eventLogPath: "/tmp/.httpi/responses/run_123/events.jsonl",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  });

  assert.equal(redactedSession.stepOutputs.login.sessionValue, redactedValue);
  assert.equal(redactedSession.stepOutputs.login.userName, "Ada");
  assert.equal(
    redactedSession.stepRecords.login.output.sessionValue,
    redactedValue,
  );
  assert.equal(redactedSession.stepRecords.login.output.userName, "Ada");
  assert.equal(
    redactedSession.compiled.steps[0].request.defaults.apiToken,
    redactedValue,
  );
  assert.equal(
    redactedSession.compiled.steps[0].request.defaults.label,
    "safe",
  );
});

test("CLI failure mapping preserves documented exit codes", () => {
  const validationFailure = toCliFailure(
    new HttpiError("PROJECT_INVALID", "Bad project.", {
      exitCode: exitCodes.validationFailure,
    }),
  );
  assert.deepEqual(validationFailure, {
    message: "Bad project.",
    exitCode: exitCodes.validationFailure,
  });

  const internalFailure = toCliFailure(new Error("boom"));
  assert.deepEqual(internalFailure, {
    message: "boom",
    exitCode: exitCodes.internalError,
  });
});

test("runtime session locks reject concurrent access", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-lock-"));

  try {
    const initialLock = await acquireSessionLock(projectRoot, "run_123");

    await assert.rejects(
      async () => {
        await acquireSessionLock(projectRoot, "run_123");
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "SESSION_LOCKED" &&
        error.exitCode === exitCodes.unsafeResume,
    );

    await releaseSessionLock(initialLock);

    const nextLock = await acquireSessionLock(projectRoot, "run_123");
    await releaseSessionLock(nextLock);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime paths reject symlinked .httpi roots", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-runtime-"));

  try {
    const redirectedRuntimeDir = join(projectRoot, "redirected-runtime");
    await mkdir(redirectedRuntimeDir, { recursive: true });
    await symlink(redirectedRuntimeDir, join(projectRoot, ".httpi"));

    await assert.rejects(
      async () => {
        await ensureRuntimePaths(projectRoot);
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "RUNTIME_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime artifact roots reject symlinked session directories", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-artifacts-"));

  try {
    const session = createSessionRecord(
      {
        schemaVersion: 1,
        source: "request",
        requestId: "ping",
        envId: "dev",
        configPath: join(projectRoot, "httpi", "config.yaml"),
        configHash: "config-hash",
        configDefaults: {},
        capture: {
          requestSummary: true,
          responseMetadata: true,
          responseBody: "full",
          maxBodyBytes: 1024,
          redactHeaders: ["authorization"],
        },
        envPath: join(projectRoot, "httpi", "env", "dev.env.yaml"),
        envHash: "env-hash",
        envValues: {},
        runInputs: {},
        definitionHashes: {},
        steps: [
          {
            kind: "request",
            id: "ping",
            requestId: "ping",
            with: {},
            request: {
              requestId: "ping",
              filePath: join(
                projectRoot,
                "httpi",
                "requests",
                "ping.request.yaml",
              ),
              hash: "request-hash",
              method: "GET",
              url: "https://example.test/ping",
              defaults: {},
              headers: {},
              headerBlocks: [],
              expect: {},
              extract: {},
            },
          },
        ],
        createdAt: "2026-04-11T00:00:00.000Z",
      },
      "request_test-session",
    );

    const runtimePaths = await ensureRuntimePaths(projectRoot);
    const redirectedArtifactRoot = join(projectRoot, "redirected-artifacts");
    await mkdir(redirectedArtifactRoot, { recursive: true });
    await symlink(
      redirectedArtifactRoot,
      join(runtimePaths.responsesDir, session.sessionId),
    );

    await assert.rejects(
      async () => {
        await writeStepArtifacts(projectRoot, session, {
          stepId: "ping",
          attempt: 1,
          requestSummary: {
            method: "GET",
            url: "https://example.test/ping",
            headers: {},
          },
        });
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "RUNTIME_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tracked project roots reject symlinked httpi directories", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-tracked-root-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "httpi-tracked-external-"));

  try {
    await cp(fixtureProjectRoot, externalRoot, { recursive: true });
    await symlink(join(externalRoot, "httpi"), join(projectRoot, "httpi"));

    await assert.rejects(
      async () => {
        await loadProjectFiles(projectRoot);
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "PROJECT_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("runtime session reads reject symlinked session files", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-session-file-"));

  try {
    const session = createSessionRecord(
      {
        schemaVersion: 1,
        source: "request",
        requestId: "ping",
        envId: "dev",
        configPath: join(projectRoot, "httpi", "config.yaml"),
        configHash: "config-hash",
        configDefaults: {},
        capture: {
          requestSummary: true,
          responseMetadata: true,
          responseBody: "full",
          maxBodyBytes: 1024,
          redactHeaders: ["authorization"],
        },
        envPath: join(projectRoot, "httpi", "env", "dev.env.yaml"),
        envHash: "env-hash",
        envValues: {},
        runInputs: {},
        definitionHashes: {},
        steps: [],
        createdAt: "2026-04-11T00:00:00.000Z",
      },
      "request_test-session",
    );

    const runtimePaths = await ensureRuntimePaths(projectRoot);
    const externalSessionFile = join(projectRoot, "outside-session.json");
    await writeFile(externalSessionFile, JSON.stringify(session), "utf8");
    await symlink(
      externalSessionFile,
      join(runtimePaths.sessionsDir, `${session.sessionId}.json`),
    );

    await assert.rejects(
      async () => {
        await readSession(projectRoot, session.sessionId);
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "RUNTIME_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime event logs reject symlinked leaf files", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-event-log-"));

  try {
    const session = createSessionRecord(
      {
        schemaVersion: 1,
        source: "request",
        requestId: "ping",
        envId: "dev",
        configPath: join(projectRoot, "httpi", "config.yaml"),
        configHash: "config-hash",
        configDefaults: {},
        capture: {
          requestSummary: true,
          responseMetadata: true,
          responseBody: "full",
          maxBodyBytes: 1024,
          redactHeaders: ["authorization"],
        },
        envPath: join(projectRoot, "httpi", "env", "dev.env.yaml"),
        envHash: "env-hash",
        envValues: {},
        runInputs: {},
        definitionHashes: {},
        steps: [],
        createdAt: "2026-04-11T00:00:00.000Z",
      },
      "request_test-session",
    );

    const runtimePaths = await ensureRuntimePaths(projectRoot);
    const sessionResponsesDir = join(
      runtimePaths.responsesDir,
      session.sessionId,
    );
    await mkdir(sessionResponsesDir, { recursive: true });

    const externalEventLog = join(projectRoot, "outside-events.jsonl");
    await writeFile(externalEventLog, "", "utf8");
    await symlink(externalEventLog, join(sessionResponsesDir, "events.jsonl"));

    await assert.rejects(
      async () => {
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: 1,
          eventType: "session.running",
          timestamp: "2026-04-11T00:00:00.000Z",
          sessionId: session.sessionId,
          outcome: "running",
        });
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "RUNTIME_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runtime event logs reject dangling symlink leaf files", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(
    join(tmpdir(), "httpi-event-log-dangling-"),
  );

  try {
    const session = createSessionRecord(
      {
        schemaVersion: 1,
        source: "request",
        requestId: "ping",
        envId: "dev",
        configPath: join(projectRoot, "httpi", "config.yaml"),
        configHash: "config-hash",
        configDefaults: {},
        capture: {
          requestSummary: true,
          responseMetadata: true,
          responseBody: "full",
          maxBodyBytes: 1024,
          redactHeaders: ["authorization"],
        },
        envPath: join(projectRoot, "httpi", "env", "dev.env.yaml"),
        envHash: "env-hash",
        envValues: {},
        runInputs: {},
        definitionHashes: {},
        steps: [],
        createdAt: "2026-04-11T00:00:00.000Z",
      },
      "request_test-session",
    );

    const runtimePaths = await ensureRuntimePaths(projectRoot);
    const sessionResponsesDir = join(
      runtimePaths.responsesDir,
      session.sessionId,
    );
    await mkdir(sessionResponsesDir, { recursive: true });

    await symlink(
      join(projectRoot, "missing-events.jsonl"),
      join(sessionResponsesDir, "events.jsonl"),
    );

    await assert.rejects(
      async () => {
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: 1,
          eventType: "session.running",
          timestamp: "2026-04-11T00:00:00.000Z",
          sessionId: session.sessionId,
          outcome: "running",
        });
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "RUNTIME_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("HTTP requests map slow endpoints to HTTP_REQUEST_FAILED", async () => {
  const server = createServer(async (_request, response) => {
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
    if (!response.destroyed) {
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ ok: true }));
    }
  });

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(
      async () => {
        await executeHttpRequest(
          {
            method: "GET",
            url: `http://127.0.0.1:${address.port}/slow`,
            headers: {},
            timeoutMs: 50,
          },
          {
            requestSummary: true,
            responseMetadata: true,
            responseBody: "full",
            maxBodyBytes: 1024,
            redactHeaders: [],
          },
        );
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "HTTP_REQUEST_FAILED" &&
        error.exitCode === exitCodes.executionFailure,
    );
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }
});

test("project validation reports secret literals and invalid run wiring", async () => {
  const projectRoot = await createFixtureProjectCopy();

  try {
    await writeFile(
      join(projectRoot, "httpi", "requests", "unsafe.request.yaml"),
      [
        "kind: request",
        "title: Unsafe request",
        "method: GET",
        'url: "https://example.test/unsafe"',
        "headers:",
        '  authorization: "Bearer hard-coded-token"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "httpi", "requests", "unsafe-header-auth.request.yaml"),
      [
        "kind: request",
        "title: Unsafe header auth request",
        "method: GET",
        'url: "https://example.test/header-auth"',
        "auth:",
        "  scheme: header",
        '  header: "x-api-key"',
        '  value: "literal-secret"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectRoot, "httpi", "runs", "invalid.run.yaml"),
      [
        "kind: run",
        "title: Invalid run",
        "env: missing-env",
        "steps:",
        "  - kind: parallel",
        "    id: invalid-parallel",
        "    steps:",
        "      - kind: pause",
        "        id: stop-here",
        '        reason: "not allowed"',
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);

    assert(
      project.diagnostics.some(
        (diagnostic) => diagnostic.code === "SECRET_LITERAL",
      ),
    );
    assert(
      project.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "SECRET_LITERAL" &&
          diagnostic.path === "auth.value",
      ),
    );
    assert(
      project.diagnostics.some(
        (diagnostic) => diagnostic.code === "RUN_ENV_NOT_FOUND",
      ),
    );
    assert(
      project.diagnostics.some(
        (diagnostic) => diagnostic.code === "INVALID_PARALLEL_CHILD_KIND",
      ),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("initProject rejects symlinked tracked roots", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-init-root-"));
  const externalTrackedRoot = await mkdtemp(
    join(tmpdir(), "httpi-init-external-"),
  );

  try {
    await symlink(externalTrackedRoot, join(projectRoot, "httpi"));

    await assert.rejects(
      async () => {
        await initProject(projectRoot);
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "PROJECT_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalTrackedRoot, { recursive: true, force: true });
  }
});

test("initProject rejects symlinked .gitignore files", async () => {
  if (process.platform === "win32") {
    return;
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-init-gitignore-"));
  const externalRoot = await mkdtemp(
    join(tmpdir(), "httpi-init-gitignore-ext-"),
  );

  try {
    await writeFile(
      join(externalRoot, "shared.gitignore"),
      "# shared\n",
      "utf8",
    );
    await symlink(
      join(externalRoot, "shared.gitignore"),
      join(projectRoot, ".gitignore"),
    );

    await assert.rejects(
      async () => {
        await initProject(projectRoot);
      },
      (error) =>
        error instanceof HttpiError &&
        error.code === "PROJECT_PATH_INVALID" &&
        error.exitCode === exitCodes.validationFailure,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("YAML parse diagnostics include line and column details", async () => {
  const projectRoot = await createFixtureProjectCopy();

  try {
    await writeFile(
      join(projectRoot, "httpi", "requests", "broken.request.yaml"),
      [
        "kind: request",
        "title: Broken request",
        "method: GET",
        "headers:",
        "  authorization: [oops",
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);
    const parseDiagnostic = project.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "YAML_PARSE_ERROR" &&
        diagnostic.filePath.endsWith("broken.request.yaml"),
    );
    assert(parseDiagnostic);
    assert.equal(typeof parseDiagnostic.line, "number");
    assert.equal(typeof parseDiagnostic.column, "number");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("semantic validation diagnostics include file, line, column, and hint", async () => {
  const projectRoot = await createFixtureProjectCopy();

  try {
    await mkdir(join(projectRoot, "httpi", "runs", "security"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, "httpi", "runs", "security", "invalid.run.yaml"),
      [
        "kind: run",
        "title: Invalid run",
        "env: missing-env",
        "steps:",
        "  - kind: parallel",
        "    id: invalid-parallel",
        "    steps:",
        "      - kind: pause",
        "        id: stop-here",
        '        reason: "not allowed"',
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);

    const envDiagnostic = project.diagnostics.find(
      (diagnostic) => diagnostic.code === "RUN_ENV_NOT_FOUND",
    );
    assert(envDiagnostic);
    assert.equal(envDiagnostic.file, "httpi/runs/security/invalid.run.yaml");
    assert.match(envDiagnostic.filePath, /invalid\.run\.yaml$/);
    assert.equal(envDiagnostic.line, 3);
    assert.equal(envDiagnostic.column, 1);
    assert.match(
      envDiagnostic.hint,
      /Create the missing referenced definition or update this reference/,
    );

    const kindDiagnostic = project.diagnostics.find(
      (diagnostic) => diagnostic.code === "INVALID_PARALLEL_CHILD_KIND",
    );
    assert(kindDiagnostic);
    assert.match(kindDiagnostic.file, /invalid\.run\.yaml$/);
    assert.equal(kindDiagnostic.line, 8);
    assert.equal(typeof kindDiagnostic.column, "number");
    assert.match(
      kindDiagnostic.hint,
      /Use a supported step kind for this location or restructure the run/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("config capture diagnostics point at exact capture keys", async () => {
  const projectRoot = await createFixtureProjectCopy();

  try {
    await writeFile(
      join(projectRoot, "httpi", "config.yaml"),
      [
        "schemaVersion: 1",
        "project: Fixture Project",
        "capture:",
        '  requestSummary: "yes"',
        '  responseMetadata: "sure"',
        '  maxBodyBytes: "huge"',
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);

    const requestSummaryDiagnostic = project.diagnostics.find(
      (diagnostic) => diagnostic.path === "capture.requestSummary",
    );
    assert(requestSummaryDiagnostic);
    assert.equal(requestSummaryDiagnostic.code, "INVALID_BOOLEAN");
    assert.equal(requestSummaryDiagnostic.line, 4);

    const responseMetadataDiagnostic = project.diagnostics.find(
      (diagnostic) => diagnostic.path === "capture.responseMetadata",
    );
    assert(responseMetadataDiagnostic);
    assert.equal(responseMetadataDiagnostic.code, "INVALID_BOOLEAN");
    assert.equal(responseMetadataDiagnostic.line, 5);

    const maxBodyBytesDiagnostic = project.diagnostics.find(
      (diagnostic) => diagnostic.path === "capture.maxBodyBytes",
    );
    assert(maxBodyBytesDiagnostic);
    assert.equal(maxBodyBytesDiagnostic.code, "INVALID_NUMBER");
    assert.equal(maxBodyBytesDiagnostic.line, 6);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("typoed required keys point at the misspelled YAML key", async () => {
  const projectRoot = await createFixtureProjectCopy();

  try {
    await writeFile(
      join(projectRoot, "httpi", "requests", "typo.request.yaml"),
      [
        "kind: request",
        "title: Typo request",
        "mthod: GET",
        'url: "{{baseUrl}}/ping"',
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);
    const methodDiagnostic = project.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "INVALID_STRING" &&
        diagnostic.filePath.endsWith("typo.request.yaml"),
    );
    assert(methodDiagnostic);
    assert.match(methodDiagnostic.file, /typo\.request\.yaml$/);
    assert.equal(methodDiagnostic.line, 3);
    assert.equal(methodDiagnostic.path, "mthod");
    assert.match(methodDiagnostic.message, /Found mthod instead/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("secret literal diagnostics point at dotted keys exactly", async () => {
  const projectRoot = await createFixtureProjectCopy();

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
        "dotted-secret.request.yaml",
      ),
      [
        "kind: request",
        "title: Dotted secret",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "headers:",
        '  "x.api-key": super-secret-token',
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);
    const secretDiagnostic = project.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "SECRET_LITERAL" &&
        diagnostic.filePath.endsWith("dotted-secret.request.yaml"),
    );
    assert(secretDiagnostic);
    assert.equal(
      secretDiagnostic.file,
      "httpi/requests/security/dotted-secret.request.yaml",
    );
    assert.equal(secretDiagnostic.line, 6);
    assert.equal(secretDiagnostic.path, 'headers["x.api-key"]');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("secret literal diagnostics roundtrip escaped quoted keys", async () => {
  const projectRoot = await createFixtureProjectCopy();

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
        "quoted-secret.request.yaml",
      ),
      [
        "kind: request",
        "title: Quoted secret",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "headers:",
        `  'x.api-key"]': super-secret-token`,
        "",
      ].join("\n"),
      "utf8",
    );

    const project = await loadProjectFiles(projectRoot);
    const secretDiagnostic = project.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "SECRET_LITERAL" &&
        diagnostic.filePath.endsWith("quoted-secret.request.yaml"),
    );
    assert(secretDiagnostic);
    assert.equal(
      secretDiagnostic.file,
      "httpi/requests/security/quoted-secret.request.yaml",
    );
    assert.equal(secretDiagnostic.line, 6);
    assert.equal(secretDiagnostic.path, 'headers["x.api-key\\"]"]');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("diagnostic helpers keep public paths safe and stable", () => {
  assert.equal(appendDiagnosticPath("", "first"), "first");
  assert.equal(
    appendDiagnosticPath("headers", 'x.api-key"]'),
    'headers["x.api-key\\"]"]',
  );
  assert.equal(
    toDisplayDiagnosticFile("/tmp/private/httpi-work/file.yaml"),
    "<unknown>",
  );
  assert.equal(
    toDisplayDiagnosticFile("httpi/requests/ping.request.yaml"),
    "httpi/requests/ping.request.yaml",
  );
});

function createResolutionContext() {
  return {
    projectRoot: "/tmp/httpi",
    compiled: {
      schemaVersion: 1,
      source: "run",
      runId: "smoke",
      envId: "dev",
      configPath: "/tmp/httpi/config.yaml",
      configHash: "config-hash",
      configDefaults: {},
      capture: {
        requestSummary: true,
        responseMetadata: true,
        responseBody: "full",
        maxBodyBytes: 1024,
        redactHeaders: ["authorization"],
      },
      envPath: "/tmp/httpi/env/dev.env.yaml",
      envHash: "env-hash",
      envValues: {},
      runInputs: {},
      overrideKeys: [],
      definitionHashes: {},
      steps: [],
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    step: {
      kind: "request",
      id: "touch-user",
      requestId: "users/touch-user",
      with: {
        authToken: "{{steps.login.sessionValue}}",
        note: "{{steps.login.userName}}",
      },
      request: {
        requestId: "users/touch-user",
        filePath: "/tmp/httpi/requests/users/touch-user.request.yaml",
        hash: "request-hash",
        method: "POST",
        url: "{{baseUrl}}/users/{{userId}}/touch",
        defaults: {},
        headers: {},
        headerBlocks: [],
        expect: {},
        extract: {},
      },
    },
    stepOutputs: {
      login: {
        sessionValue: "secret-token",
        userName: "Ada",
      },
    },
    secretStepOutputs: {
      login: ["sessionValue"],
    },
    secrets: {},
    processEnv: {},
  };
}

function findVariable(variables, name) {
  const variable = variables.find((entry) => entry.name === name);
  assert.ok(variable, `Expected variable ${name} to exist.`);
  return variable;
}

async function createFixtureProjectCopy() {
  const projectRoot = await mkdtemp(join(tmpdir(), "httpi-unit-fixture-"));
  await cp(fixtureProjectRoot, projectRoot, { recursive: true });
  return projectRoot;
}

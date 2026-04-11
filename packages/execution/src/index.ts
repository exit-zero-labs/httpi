import { basename, extname, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { lstat, readFile, realpath } from "node:fs/promises";
import type {
  ArtifactListResult,
  ArtifactReadResult,
  CompiledParallelStep,
  CompiledRequestStep,
  CompiledRunSnapshot,
  DescribeRequestResult,
  DescribeRunResult,
  DescribeRunStep,
  Diagnostic,
  ExecutionResult,
  ExplainVariablesResult,
  FlatVariableMap,
  FlatVariableValue,
  HttpExecutionResult,
  JsonValue,
  ListDefinitionsResult,
  ResolvedRequestBody,
  ResolvedRequestModel,
  SessionRecord,
  SessionStateResult,
  SessionStepRecord,
  StepArtifactSummary,
  VariableExplanation,
} from "@e0l/httpi-contracts";
import {
  compileRequestSnapshot,
  compileRunSnapshot,
  findProjectRoot,
  loadProjectFiles,
} from "@e0l/httpi-definitions";
import { executeHttpRequest } from "@e0l/httpi-http";
import {
  acquireSessionLock,
  appendSessionEvent,
  createSessionRecord,
  detectDefinitionDrift,
  ensureRuntimePaths,
  listArtifacts,
  listSessions,
  loadSecrets,
  readArtifact,
  readSession,
  redactArtifactText,
  releaseSessionLock,
  writeSession,
  writeStepArtifacts,
} from "@e0l/httpi-runtime";
import {
  HttpiError,
  assertPathWithin,
  coerceErrorMessage,
  ensureDir,
  exitCodes,
  fileExists,
  interpolateTemplate,
  looksLikeSecretFieldName,
  mergeStringRecords,
  normalizeHeaderName,
  readUtf8File,
  redactedValue,
  redactHeaders,
  redactText,
  resolveFromRoot,
  runtimeDirectoryName,
  toIsoTimestamp,
  trackedDirectoryName,
  writeUtf8File,
} from "@e0l/httpi-shared";

export interface EngineOptions {
  cwd?: string | undefined;
  projectRoot?: string | undefined;
}

export interface InitProjectResult {
  rootDir: string;
  createdPaths: string[];
}

interface LoadedProjectContext {
  rootDir: string;
  project: Awaited<ReturnType<typeof loadProjectFiles>>;
}

interface RequestResolutionContext {
  projectRoot: string;
  compiled: CompiledRunSnapshot;
  step: CompiledRequestStep;
  stepOutputs: Record<string, Record<string, FlatVariableValue>>;
  secretStepOutputs: Record<string, string[]>;
  secrets: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
}

interface ResolvedScalarValue {
  value: FlatVariableValue;
  source: VariableExplanation["source"];
  secret: boolean;
  secretValues: string[];
}

interface RequestMaterializationResult {
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
}

interface ExtractedStepOutputs {
  values: Record<string, FlatVariableValue>;
  secretOutputKeys: string[];
}

interface RequestExecutionOutcome {
  session: SessionRecord;
  success: boolean;
}

const schemaBaseUrl =
  "https://raw.githubusercontent.com/exit-zero-labs/httpi/main/packages/contracts/schemas";

function buildCompileOptions(
  envId?: string,
  overrides?: FlatVariableMap,
): {
  envId?: string | undefined;
  overrides?: FlatVariableMap | undefined;
} {
  return {
    envId,
    overrides,
  };
}

function getSingleRequestStep(
  compiled: CompiledRunSnapshot,
  targetId: string,
): CompiledRequestStep {
  const step = compiled.steps[0];
  if (!step || step.kind !== "request") {
    throw new HttpiError(
      "INVALID_COMPILED_REQUEST",
      `Compiled request ${targetId} did not produce a request step.`,
    );
  }

  return step;
}

function getSessionStepRecord(
  session: SessionRecord,
  stepId: string,
): SessionStepRecord {
  const stepRecord = session.stepRecords[stepId];
  if (!stepRecord) {
    throw new HttpiError(
      "STEP_NOT_FOUND",
      `Step ${stepId} was not found in session ${session.sessionId}.`,
      { exitCode: exitCodes.internalError },
    );
  }

  return stepRecord;
}

function schemaComment(schemaFileName: string): string {
  return `# yaml-language-server: $schema=${schemaBaseUrl}/${schemaFileName}`;
}

export async function initProject(
  targetDirectory = process.cwd(),
): Promise<InitProjectResult> {
  const rootDir = resolve(targetDirectory);
  const trackedRoot = resolveFromRoot(rootDir, trackedDirectoryName);
  const createdPaths: string[] = [];

  await ensureDir(resolveFromRoot(trackedRoot, "env"));
  await ensureDir(resolveFromRoot(trackedRoot, "requests"));
  await ensureDir(resolveFromRoot(trackedRoot, "runs"));
  await ensureDir(resolveFromRoot(trackedRoot, "blocks", "headers"));
  await ensureDir(resolveFromRoot(trackedRoot, "blocks", "auth"));
  await ensureDir(resolveFromRoot(trackedRoot, "bodies"));
  await ensureDir(resolveFromRoot(rootDir, runtimeDirectoryName));

  createdPaths.push(
    ...(await writeTemplateIfMissing(
      resolveFromRoot(trackedRoot, "config.yaml"),
      [
        schemaComment("config.schema.json"),
        "schemaVersion: 1",
        `project: ${JSON.stringify(basename(rootDir) || "httpi-project")}`,
        "defaultEnv: dev",
        "",
        "defaults:",
        "  timeoutMs: 10000",
        "",
        "capture:",
        "  requestSummary: true",
        "  responseMetadata: true",
        "  responseBody: full",
        "  maxBodyBytes: 1048576",
        "  redactHeaders:",
        "    - authorization",
        "    - cookie",
        "    - set-cookie",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      resolveFromRoot(trackedRoot, "env", "dev.env.yaml"),
      [
        schemaComment("env.schema.json"),
        "schemaVersion: 1",
        "title: Development",
        "values:",
        "  baseUrl: http://localhost:3000",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      resolveFromRoot(trackedRoot, "requests", "ping.request.yaml"),
      [
        schemaComment("request.schema.json"),
        "kind: request",
        "title: Ping",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      resolveFromRoot(trackedRoot, "runs", "smoke.run.yaml"),
      [
        schemaComment("run.schema.json"),
        "kind: run",
        "title: Smoke",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: ping",
        "    uses: ping",
        "",
      ].join("\n"),
    )),
  );

  const gitignorePath = resolveFromRoot(rootDir, ".gitignore");
  if (!(await fileExists(gitignorePath))) {
    await writeUtf8File(gitignorePath, `${runtimeDirectoryName}/\n`);
    createdPaths.push(gitignorePath);
  } else {
    const currentGitignore = await readUtf8File(gitignorePath);
    if (!currentGitignore.includes(`${runtimeDirectoryName}/`)) {
      const nextContent = currentGitignore.endsWith("\n")
        ? `${currentGitignore}${runtimeDirectoryName}/\n`
        : `${currentGitignore}\n${runtimeDirectoryName}/\n`;
      await writeUtf8File(gitignorePath, nextContent);
    }
  }

  return {
    rootDir,
    createdPaths,
  };
}

export async function listProjectDefinitions(
  options: EngineOptions = {},
): Promise<ListDefinitionsResult> {
  const context = await loadProjectContext(options);
  const sessions = await listSessions(context.rootDir);

  return {
    rootDir: context.rootDir,
    requests: Object.values(context.project.requests).map((requestFile) => ({
      id: requestFile.id,
      title: requestFile.title,
      filePath: requestFile.filePath,
    })),
    runs: Object.values(context.project.runs).map((runFile) => ({
      id: runFile.id,
      title: runFile.title,
      filePath: runFile.filePath,
    })),
    envs: Object.values(context.project.environments).map(
      (environmentFile) => ({
        id: environmentFile.id,
        title: environmentFile.title,
        filePath: environmentFile.filePath,
      }),
    ),
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      runId: session.runId,
      envId: session.envId,
      state: session.state,
      nextStepId: session.nextStepId,
      updatedAt: session.updatedAt,
    })),
    diagnostics: context.project.diagnostics,
  };
}

export async function validateProject(options: EngineOptions = {}): Promise<{
  rootDir: string;
  diagnostics: Diagnostic[];
}> {
  const context = await loadProjectContext(options);
  return {
    rootDir: context.rootDir,
    diagnostics: context.project.diagnostics,
  };
}

export async function describeRequest(
  requestId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<DescribeRequestResult> {
  const context = await loadProjectContext(options);
  const compiled = compileRequestSnapshot(
    context.project,
    requestId,
    buildCompileOptions(options.envId, options.overrides),
  );
  const step = getSingleRequestStep(compiled, requestId);
  const materialized = await materializeRequest(
    context.rootDir,
    compiled,
    step,
    {},
    {},
  );
  return {
    requestId,
    envId: compiled.envId,
    request: redactResolvedRequestModel(materialized.request),
    variables: redactVariableExplanations(materialized.variables),
    diagnostics: context.project.diagnostics,
  };
}

export async function describeRun(
  runId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<DescribeRunResult> {
  const context = await loadProjectContext(options);
  const compiled = compileRunSnapshot(
    context.project,
    runId,
    buildCompileOptions(options.envId, options.overrides),
  );

  return {
    runId,
    envId: compiled.envId,
    title: compiled.title,
    steps: compiled.steps.map((step) => describeCompiledStep(step)),
    diagnostics: context.project.diagnostics,
  };
}

export async function runRequest(
  requestId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<ExecutionResult> {
  const context = await loadProjectContext(options);
  const compiled = compileRequestSnapshot(
    context.project,
    requestId,
    buildCompileOptions(options.envId, options.overrides),
  );

  const session = createSessionRecord(compiled);
  const result = await executeSession(context.rootDir, session);
  return {
    ...result,
    session: redactSessionForOutput(result.session),
  };
}

export async function runRun(
  runId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<ExecutionResult> {
  const context = await loadProjectContext(options);
  const compiled = compileRunSnapshot(
    context.project,
    runId,
    buildCompileOptions(options.envId, options.overrides),
  );

  const session = createSessionRecord(compiled);
  const result = await executeSession(context.rootDir, session);
  return {
    ...result,
    session: redactSessionForOutput(result.session),
  };
}

export async function resumeSessionRun(
  sessionId: string,
  options: EngineOptions = {},
): Promise<ExecutionResult> {
  const rootDir = await findProjectRoot(options);
  const session = await readSession(rootDir, sessionId);

  if (session.state !== "paused" && session.state !== "failed") {
    throw new HttpiError(
      "SESSION_NOT_RESUMABLE",
      `Session ${sessionId} is ${session.state} and cannot be resumed.`,
      { exitCode: exitCodes.unsafeResume },
    );
  }

  const driftDiagnostics = await detectDefinitionDrift(session);
  if (driftDiagnostics.some((diagnostic) => diagnostic.level === "error")) {
    throw new HttpiError(
      "SESSION_DRIFT_DETECTED",
      `Session ${sessionId} cannot be resumed because tracked definitions changed.`,
      {
        exitCode: exitCodes.unsafeResume,
        details: driftDiagnostics,
      },
    );
  }

  const result = await executeSession(rootDir, session);
  return {
    ...result,
    session: redactSessionForOutput(result.session),
  };
}

export async function getSessionState(
  sessionId: string,
  options: EngineOptions = {},
): Promise<SessionStateResult> {
  const rootDir = await findProjectRoot(options);
  const session = await readSession(rootDir, sessionId);
  const diagnostics = await detectDefinitionDrift(session);
  return {
    session: redactSessionForOutput(session),
    diagnostics,
  };
}

export async function listSessionArtifacts(
  sessionId: string,
  options: EngineOptions & { stepId?: string | undefined } = {},
): Promise<ArtifactListResult> {
  const rootDir = await findProjectRoot(options);
  const artifacts = await listArtifacts(rootDir, sessionId, options.stepId);
  return {
    sessionId,
    artifacts,
  };
}

export async function readSessionArtifact(
  sessionId: string,
  relativePath: string,
  options: EngineOptions = {},
): Promise<ArtifactReadResult> {
  const rootDir = await findProjectRoot(options);
  const artifact = await readArtifact(rootDir, sessionId, relativePath);
  return {
    sessionId,
    relativePath,
    contentType: artifact.contentType,
    text: artifact.text,
    base64: artifact.base64,
  };
}

export async function explainVariables(
  options: EngineOptions & {
    requestId?: string | undefined;
    runId?: string | undefined;
    stepId?: string | undefined;
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  },
): Promise<ExplainVariablesResult> {
  const context = await loadProjectContext(options);

  if (options.requestId && options.runId) {
    throw new HttpiError(
      "EXPLAIN_TARGET_AMBIGUOUS",
      "Explain variables accepts either requestId or runId, not both.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  if (options.requestId) {
    const compiled = compileRequestSnapshot(
      context.project,
      options.requestId,
      buildCompileOptions(options.envId, options.overrides),
    );
    const step = getSingleRequestStep(compiled, options.requestId);

    const materialized = await materializeRequest(
      context.rootDir,
      compiled,
      step,
      {},
      {},
    );
      return {
        targetId: options.requestId,
        envId: compiled.envId,
        variables: redactVariableExplanations(materialized.variables),
        diagnostics: context.project.diagnostics,
      };
  }

  if (!options.runId) {
    throw new HttpiError(
      "EXPLAIN_TARGET_REQUIRED",
      "Explain variables requires either requestId or runId.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  const compiled = compileRunSnapshot(
    context.project,
    options.runId,
    buildCompileOptions(options.envId, options.overrides),
  );
  const requestStep = selectExplainStep(compiled, options.stepId);
  const materialized = await materializeRequest(
    context.rootDir,
    compiled,
    requestStep,
    {},
    {},
  );

  return {
    targetId: `${options.runId}#${requestStep.id}`,
    envId: compiled.envId,
    variables: redactVariableExplanations(materialized.variables),
    diagnostics: context.project.diagnostics,
  };
}

async function executeSession(
  projectRoot: string,
  initialSession: SessionRecord,
): Promise<ExecutionResult> {
  await ensureRuntimePaths(projectRoot);
  const lock = await acquireSessionLock(projectRoot, initialSession.sessionId);

  try {
    let session = initialSession;
    session = {
      ...session,
      state: "running",
      pausedReason: undefined,
      failureReason: undefined,
      updatedAt: toIsoTimestamp(),
    };

    await writeSession(projectRoot, session);
    await appendSessionEvent(projectRoot, session, {
      schemaVersion: session.schemaVersion,
      eventType: "session.running",
      timestamp: toIsoTimestamp(),
      sessionId: session.sessionId,
      runId: session.runId,
      outcome: "running",
    });

    const startIndex = findStepStartIndex(session);
    for (
      let index = startIndex;
      index < session.compiled.steps.length;
      index += 1
    ) {
      const topLevelStep = session.compiled.steps[index];
      if (!topLevelStep) {
        continue;
      }
      const nextTopLevelStep = session.compiled.steps[index + 1];

      if (topLevelStep.kind === "pause") {
        session = applyPause(
          session,
          topLevelStep.id,
          topLevelStep.reason,
          nextTopLevelStep?.id,
        );
        await writeSession(projectRoot, session);
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: session.schemaVersion,
          eventType: "session.paused",
          timestamp: toIsoTimestamp(),
          sessionId: session.sessionId,
          runId: session.runId,
          stepId: topLevelStep.id,
          outcome: "paused",
          message: topLevelStep.reason,
        });
        return {
          session,
          diagnostics: [],
        };
      }

      if (topLevelStep.kind === "parallel") {
        const parallelOutcome = await executeParallelStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...parallelOutcome.session,
          nextStepId: parallelOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
      } else {
        const requestOutcome = await executeRequestStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...requestOutcome.session,
          nextStepId: requestOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
      }

      await writeSession(projectRoot, session);
      if (session.state === "failed") {
        return {
          session,
          diagnostics: [],
        };
      }
    }

    session = {
      ...session,
      state: "completed",
      nextStepId: undefined,
      updatedAt: toIsoTimestamp(),
      pausedReason: undefined,
      failureReason: undefined,
    };
    await writeSession(projectRoot, session);
    await appendSessionEvent(projectRoot, session, {
      schemaVersion: session.schemaVersion,
      eventType: "session.completed",
      timestamp: toIsoTimestamp(),
      sessionId: session.sessionId,
      runId: session.runId,
      outcome: "success",
    });

    return {
      session,
      diagnostics: [],
    };
  } finally {
    await releaseSessionLock(lock);
  }
}

async function executeParallelStep(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledParallelStep,
): Promise<RequestExecutionOutcome> {
  const parallelAttempt = nextAttemptNumber(session, step.id);
  const runningSession = startAttempt(
    session,
    step.id,
    "parallel",
    parallelAttempt,
  );
  await writeSession(projectRoot, runningSession);
  await appendSessionEvent(projectRoot, runningSession, {
    schemaVersion: runningSession.schemaVersion,
    eventType: "step.started",
    timestamp: toIsoTimestamp(),
    sessionId: runningSession.sessionId,
    runId: runningSession.runId,
    stepId: step.id,
    attempt: parallelAttempt,
    outcome: "running",
  });

  // Child results stay in memory here and are merged back into one persisted
  // parent session after the parallel block settles.
  const childResults = await Promise.all(
    step.steps.map(async (childStep) =>
      executeRequestStep(projectRoot, runningSession, childStep, false),
    ),
  );

  let nextSession = runningSession;
  let success = true;
  for (const [index, childResult] of childResults.entries()) {
    const childStep = step.steps[index];
    if (!childStep) {
      continue;
    }

    const childStepRecord = getSessionStepRecord(
      childResult.session,
      childStep.id,
    );
    const childStepOutput = childResult.session.stepOutputs[childStep.id];
    nextSession = {
      ...nextSession,
      stepRecords: {
        ...nextSession.stepRecords,
        [childStep.id]: childStepRecord,
      },
      stepOutputs: {
        ...nextSession.stepOutputs,
        ...(childStepOutput ? { [childStep.id]: childStepOutput } : {}),
      },
      updatedAt: childResult.session.updatedAt,
      ...(childResult.success
        ? {}
        : {
            failureReason: childResult.session.failureReason,
          }),
    };
    success &&= childResult.success;
  }

  const finalizedParentAttempt = finishAttempt(
    nextSession,
    step.id,
    success ? "completed" : "failed",
    parallelAttempt,
    success
      ? {
          outcome: "success",
        }
      : {
          outcome: "failed",
          errorMessage: "One or more child steps failed.",
        },
  );

  const finalSession: SessionRecord = {
    ...finalizedParentAttempt,
    state: success ? "running" : "failed",
    pausedReason: undefined,
    ...(success ? {} : { failureReason: "One or more child steps failed." }),
  };

  await appendSessionEvent(projectRoot, finalSession, {
    schemaVersion: finalSession.schemaVersion,
    eventType: success ? "step.completed" : "step.failed",
    timestamp: toIsoTimestamp(),
    sessionId: finalSession.sessionId,
    runId: finalSession.runId,
    stepId: step.id,
    attempt: parallelAttempt,
    outcome: success ? "success" : "failed",
  });

  return {
    session: finalSession,
    success,
  };
}

async function executeRequestStep(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
  persistState = true,
): Promise<RequestExecutionOutcome> {
  const attempt = nextAttemptNumber(session, step.id);
  let nextSession = startAttempt(session, step.id, "request", attempt);

  if (persistState) {
    await writeSession(projectRoot, nextSession);
  }

  await appendSessionEvent(projectRoot, nextSession, {
    schemaVersion: nextSession.schemaVersion,
    eventType: "step.started",
    timestamp: toIsoTimestamp(),
    sessionId: nextSession.sessionId,
    runId: nextSession.runId,
    stepId: step.id,
    attempt,
    outcome: "running",
  });

  let exchange: HttpExecutionResult | undefined;
  let materialized: RequestMaterializationResult | undefined;
  let extractedOutputs: ExtractedStepOutputs = {
    values: {},
    secretOutputKeys: [],
  };
  let secretValues: string[] = [];
  let artifactSummary: StepArtifactSummary | undefined;

  try {
    materialized = await materializeRequest(
      projectRoot,
      nextSession.compiled,
      step,
      nextSession.stepOutputs,
      collectSecretStepOutputs(nextSession.stepRecords),
    );
    secretValues = materialized.request.secretValues;
    exchange = await executeHttpRequest(
      materialized.request,
      nextSession.compiled.capture,
    );
    assertStatusExpectation(step, exchange);
    extractedOutputs = extractStepOutputs(step, exchange);
    const extractedSecretValues = collectSecretOutputValues(extractedOutputs);

    artifactSummary = await maybeWriteRequestArtifacts(
      projectRoot,
      nextSession,
      step,
      attempt,
      materialized.request,
      exchange,
      uniqueSecretValues([...secretValues, ...extractedSecretValues]),
    );

    nextSession = finishAttempt(nextSession, step.id, "completed", attempt, {
      outcome: "success",
      statusCode: exchange.response.status,
      durationMs: exchange.durationMs,
      ...(artifactSummary ? { artifacts: artifactSummary } : {}),
    });
    const stepRecord = getSessionStepRecord(nextSession, step.id);
    nextSession = {
      ...nextSession,
      state: "running",
      pausedReason: undefined,
      failureReason: undefined,
      stepOutputs: {
        ...nextSession.stepOutputs,
        [step.id]: extractedOutputs.values,
      },
      stepRecords: {
        ...nextSession.stepRecords,
        [step.id]: {
          ...stepRecord,
          output: extractedOutputs.values,
          secretOutputKeys: extractedOutputs.secretOutputKeys,
        },
      },
      updatedAt: toIsoTimestamp(),
    };

    await appendSessionEvent(projectRoot, nextSession, {
      schemaVersion: nextSession.schemaVersion,
      eventType: "step.completed",
      timestamp: toIsoTimestamp(),
      sessionId: nextSession.sessionId,
      runId: nextSession.runId,
      stepId: step.id,
      attempt,
      durationMs: exchange.durationMs,
      outcome: "success",
    });

    return {
      session: nextSession,
      success: true,
    };
  } catch (error) {
    const message = coerceErrorMessage(error);

    if (materialized && exchange) {
      artifactSummary = await maybeWriteRequestArtifacts(
        projectRoot,
        nextSession,
        step,
        attempt,
        materialized.request,
        exchange,
        secretValues,
      );
    }

    nextSession = finishAttempt(nextSession, step.id, "failed", attempt, {
      outcome: "failed",
      errorMessage: redactArtifactText(message, secretValues),
      ...(exchange
        ? {
            statusCode: exchange.response.status,
            durationMs: exchange.durationMs,
          }
        : {}),
      ...(artifactSummary ? { artifacts: artifactSummary } : {}),
    });
    nextSession = {
      ...nextSession,
      state: "failed",
      pausedReason: undefined,
      failureReason: redactArtifactText(message, secretValues),
      updatedAt: toIsoTimestamp(),
    };

    await appendSessionEvent(projectRoot, nextSession, {
      schemaVersion: nextSession.schemaVersion,
      eventType: "step.failed",
      timestamp: toIsoTimestamp(),
      sessionId: nextSession.sessionId,
      runId: nextSession.runId,
      stepId: step.id,
      attempt,
      durationMs: exchange?.durationMs,
      outcome: "failed",
      errorClass: error instanceof Error ? error.name : "Error",
      message: redactArtifactText(message, secretValues),
    });

    return {
      session: nextSession,
      success: false,
    };
  }
}

async function maybeWriteRequestArtifacts(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
  attempt: number,
  request: ResolvedRequestModel,
  exchange: HttpExecutionResult,
  secretValues: string[],
): Promise<StepArtifactSummary | undefined> {
  const capture = session.compiled.capture;
  if (
    !capture.requestSummary &&
    !capture.responseMetadata &&
    capture.responseBody === "none"
  ) {
    return undefined;
  }

  const requestSummary = capture.requestSummary
    ? {
        requestId: step.requestId,
        stepId: step.id,
        method: request.method,
        url: redactArtifactText(request.url, secretValues),
        headers: redactHeaders(
          request.headers,
          capture.redactHeaders,
          secretValues,
        ),
        bodyBytes:
          request.body?.binary?.byteLength ??
          (request.body?.text ? Buffer.byteLength(request.body.text) : 0),
        timeoutMs: request.timeoutMs,
      }
    : undefined;

  const responseMetadata = capture.responseMetadata
    ? {
        status: exchange.response.status,
        statusText: exchange.response.statusText,
        headers: redactHeaders(
          exchange.response.headers,
          capture.redactHeaders,
          secretValues,
        ),
        bodyBytes: exchange.response.bodyBytes,
        truncated: exchange.response.truncated,
        durationMs: exchange.durationMs,
      }
    : undefined;

  let bodyText: string | undefined;
  let bodyBase64: string | undefined;
  if (capture.responseBody === "full") {
    if (exchange.response.bodyText !== undefined) {
      bodyText = redactArtifactText(exchange.response.bodyText, secretValues);
    } else {
      bodyBase64 = exchange.response.bodyBase64;
    }
  }

  return writeStepArtifacts(projectRoot, session, {
    stepId: step.id,
    attempt,
    requestSummary,
    responseMetadata,
    bodyText,
    bodyBase64,
    contentType: exchange.response.contentType,
  });
}

async function materializeRequest(
  projectRoot: string,
  compiled: CompiledRunSnapshot,
  step: CompiledRequestStep,
  stepOutputs: Record<string, Record<string, FlatVariableValue>>,
  secretStepOutputs: Record<string, string[]>,
): Promise<RequestMaterializationResult> {
  const secrets = await loadSecrets(projectRoot);
  const context: RequestResolutionContext = {
    projectRoot,
    compiled,
    step,
    stepOutputs,
    secretStepOutputs,
    secrets,
    processEnv: process.env,
  };

  const resolvedUrl = resolveStringValue(step.request.url, context);
  const mergedHeaders = mergeStringRecords(
    ...step.request.headerBlocks.map((headerBlock) => headerBlock.headers),
    step.request.headers,
  );
  const resolvedHeaders = Object.entries(mergedHeaders).reduce<{
    headers: Record<string, string>;
    secretValues: string[];
  }>(
    (result, [name, value]) => {
      const resolvedHeader = resolveStringValue(value, context);
      result.headers[name] = resolvedHeader.value;
      result.secretValues.push(...resolvedHeader.secretValues);
      return result;
    },
    {
      headers: {},
      secretValues: [],
    },
  );

  const authHeaders = resolveAuthHeaders(step, context);
  const headers = mergeStringRecords(
    resolvedHeaders.headers,
    authHeaders.headers,
  );

  const body = await resolveRequestBody(projectRoot, step, context);
  if (
    body?.body.contentType &&
    !Object.keys(headers).some(
      (headerName) => normalizeHeaderName(headerName) === "content-type",
    )
  ) {
    headers["content-type"] = body.body.contentType;
  }

  const timeoutValue =
    step.request.timeoutMs ??
    resolveOptionalNumberVariable(step.request.defaults.timeoutMs) ??
    resolveOptionalNumberVariable(compiled.runInputs.timeoutMs) ??
    resolveOptionalNumberVariable(compiled.envValues.timeoutMs) ??
    resolveOptionalNumberVariable(compiled.configDefaults.timeoutMs) ??
    10_000;
  const validatedTimeoutValue = validateTimeoutMs(
    step.id,
    step.requestId,
    timeoutValue,
  );

  const variables = collectVariableExplanations(context);

  return {
    request: {
      requestId: step.requestId,
      stepId: step.id,
      method: step.request.method,
      url: resolvedUrl.value,
      headers,
      body: body?.body,
      timeoutMs: validatedTimeoutValue,
      secretValues: uniqueSecretValues([
        ...resolvedUrl.secretValues,
        ...resolvedHeaders.secretValues,
        ...authHeaders.secretValues,
        ...(body?.secretValues ?? []),
      ]),
    },
    variables,
  };
}

function resolveAuthHeaders(
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): {
  headers: Record<string, string>;
  secretValues: string[];
} {
  const auth = step.request.auth ?? step.request.authBlock?.auth;
  if (!auth) {
    return {
      headers: {},
      secretValues: [],
    };
  }

  if (auth.scheme === "bearer") {
    const resolvedToken = resolveStringValue(auth.token, context);
    return {
      headers: {
        authorization: `Bearer ${resolvedToken.value}`,
      },
      secretValues: resolvedToken.secretValues,
    };
  }

  if (auth.scheme === "basic") {
    const resolvedUsername = resolveStringValue(auth.username, context);
    const resolvedPassword = resolveStringValue(auth.password, context);
    const encoded = Buffer.from(
      `${resolvedUsername.value}:${resolvedPassword.value}`,
      "utf8",
    ).toString("base64");
    return {
      headers: {
        authorization: `Basic ${encoded}`,
      },
      secretValues: uniqueSecretValues([
        ...resolvedUsername.secretValues,
        ...resolvedPassword.secretValues,
      ]),
    };
  }

  const resolvedHeaderName = resolveStringValue(auth.header, context);
  const resolvedHeaderValue = resolveStringValue(auth.value, context);
  return {
    headers: {
      [resolvedHeaderName.value]: resolvedHeaderValue.value,
    },
    secretValues: uniqueSecretValues([
      ...resolvedHeaderName.secretValues,
      ...resolvedHeaderValue.secretValues,
    ]),
  };
}

async function resolveRequestBody(
  projectRoot: string,
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): Promise<
  | {
      body: ResolvedRequestBody;
      secretValues: string[];
    }
  | undefined
> {
  const bodyDefinition = step.request.body;
  if (!bodyDefinition) {
    return undefined;
  }

  if ("json" in bodyDefinition) {
    const resolvedJson = resolveJsonValue(bodyDefinition.json, context);
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "application/json",
        text: JSON.stringify(resolvedJson.value),
      },
      secretValues: resolvedJson.secretValues,
    };
  }

  if ("text" in bodyDefinition) {
    const resolvedText = resolveStringValue(bodyDefinition.text, context);
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "text/plain",
        text: resolvedText.value,
      },
      secretValues: resolvedText.secretValues,
    };
  }

  const bodiesDirectory = resolveFromRoot(
    projectRoot,
    trackedDirectoryName,
    "bodies",
  );
  const bodyFilePath = resolveFromRoot(bodiesDirectory, bodyDefinition.file);
  assertPathWithin(bodiesDirectory, bodyFilePath, {
    code: "BODY_FILE_PATH_INVALID",
    message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
    exitCode: exitCodes.validationFailure,
  });
  if (!(await fileExists(bodyFilePath))) {
    throw new HttpiError(
      "BODY_FILE_NOT_FOUND",
      `Body file ${bodyDefinition.file} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const bodyFileStats = await lstat(bodyFilePath);
  if (bodyFileStats.isSymbolicLink()) {
    throw new HttpiError(
      "BODY_FILE_PATH_INVALID",
      `Body file ${bodyDefinition.file} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedBodiesDirectory = await realpath(bodiesDirectory);
  const resolvedBodyFilePath = await realpath(bodyFilePath);
  assertPathWithin(resolvedBodiesDirectory, resolvedBodyFilePath, {
    code: "BODY_FILE_PATH_INVALID",
    message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
    exitCode: exitCodes.validationFailure,
  });

  const rawBody = await readFile(resolvedBodyFilePath);
  if (isTextExtension(resolvedBodyFilePath)) {
    const resolvedText = resolveStringValue(rawBody.toString("utf8"), context);
    return {
      body: {
        contentType:
          bodyDefinition.contentType ??
          inferContentTypeFromPath(resolvedBodyFilePath),
        text: resolvedText.value,
      },
      secretValues: resolvedText.secretValues,
    };
  }

  return {
    body: {
      contentType:
        bodyDefinition.contentType ??
        inferContentTypeFromPath(resolvedBodyFilePath),
      binary: rawBody,
    },
    secretValues: [],
  };
}

function resolveJsonValue(
  value: JsonValue,
  context: RequestResolutionContext,
): {
  value: JsonValue;
  secretValues: string[];
} {
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return {
      value,
      secretValues: [],
    };
  }

  if (typeof value === "string") {
    const resolved = resolveTemplateValue(value, context);
    return {
      value: resolved.value,
      secretValues: resolved.secretValues,
    };
  }

  if (Array.isArray(value)) {
    const resolvedEntries = value.map((entry) =>
      resolveJsonValue(entry, context),
    );
    return {
      value: resolvedEntries.map((entry) => entry.value),
      secretValues: uniqueSecretValues(
        resolvedEntries.flatMap((entry) => entry.secretValues),
      ),
    };
  }

  const entries = Object.entries(value).map(
    ([key, entry]) => [key, resolveJsonValue(entry, context)] as const,
  );

  return {
    value: Object.fromEntries(
      entries.map(([key, entry]) => [key, entry.value]),
    ),
    secretValues: uniqueSecretValues(
      entries.flatMap(([, entry]) => entry.secretValues),
    ),
  };
}

function resolveStringValue(
  value: string,
  context: RequestResolutionContext,
): {
  value: string;
  secretValues: string[];
} {
  const resolved = resolveTemplateValue(value, context);
  return {
    value: String(resolved.value),
    secretValues: resolved.secretValues,
  };
}

function resolveTemplateValue(
  value: string,
  context: RequestResolutionContext,
): {
  value: FlatVariableValue;
  secretValues: string[];
} {
  if (value.startsWith("$ENV:")) {
    const environmentValue = process.env[value.slice("$ENV:".length)];
    if (environmentValue === undefined) {
      throw new HttpiError(
        "PROCESS_ENV_MISSING",
        `Environment variable ${value.slice("$ENV:".length)} is required but missing.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return {
      value: environmentValue,
      secretValues: [environmentValue],
    };
  }

  const exactTokenMatch = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  const exactToken = exactTokenMatch?.[1];
  if (exactToken) {
    const resolvedValue = resolveToken(exactToken, context, new Set());
    if (!resolvedValue) {
      throw new HttpiError(
        "VARIABLE_UNRESOLVED",
        `Unable to resolve ${exactToken}.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return {
      value: resolvedValue.value,
      secretValues: resolvedValue.secretValues,
    };
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedValue = resolveToken(token, context, new Set());
    if (!resolvedValue) {
      return undefined;
    }

    return resolvedValue.value === null ? "null" : String(resolvedValue.value);
  });
  if (interpolation.unresolved.length > 0) {
    throw new HttpiError(
      "VARIABLE_UNRESOLVED",
      `Unable to resolve ${interpolation.unresolved.join(", ")}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const secretValues = uniqueSecretValues(
    interpolation.tokens.flatMap(
      (token) => resolveToken(token, context, new Set())?.secretValues ?? [],
    ),
  );

  return {
    value: interpolation.value,
    secretValues,
  };
}

function resolveToken(
  token: string,
  context: RequestResolutionContext,
  seenTokens: Set<string>,
): ResolvedScalarValue | undefined {
  const trimmedToken = token.trim();

  if (trimmedToken.startsWith("steps.")) {
    return resolveStepReference(trimmedToken, context);
  }

  if (trimmedToken.startsWith("secrets.")) {
    const alias = trimmedToken.slice("secrets.".length);
    const secretValue = context.secrets[alias];
    if (secretValue === undefined) {
      return undefined;
    }

    return {
      value: secretValue,
      source: "secret",
      secret: true,
      secretValues: [secretValue],
    };
  }

  if (seenTokens.has(trimmedToken)) {
    throw new HttpiError(
      "VARIABLE_CYCLE",
      `Detected a variable cycle while resolving ${trimmedToken}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const nextSeenTokens = new Set(seenTokens);
  nextSeenTokens.add(trimmedToken);

  // Variable resolution precedence is highest-to-lowest, and the first defined
  // value wins.
  const variableSources = [
    {
      source: "step" as const,
      values: context.step.with,
    },
    {
      source:
        context.compiled.source === "request"
          ? ("override" as const)
          : ("run" as const),
      values: context.compiled.runInputs,
    },
    {
      source: "request" as const,
      values: context.step.request.defaults,
    },
    {
      source: "env" as const,
      values: context.compiled.envValues,
    },
    {
      source: "config" as const,
      values: context.compiled.configDefaults,
    },
  ];

  for (const variableSource of variableSources) {
    if (!(trimmedToken in variableSource.values)) {
      continue;
    }

    const rawValue = variableSource.values[trimmedToken];
    if (rawValue === undefined) {
      continue;
    }
    return resolveScalarValue(
      rawValue,
      variableSource.source,
      context,
      nextSeenTokens,
    );
  }

  return undefined;
}

function resolveStepReference(
  token: string,
  context: RequestResolutionContext,
): ResolvedScalarValue | undefined {
  const match = token.match(/^steps\.([^.]+)\.(.+)$/);
  if (!match) {
    return undefined;
  }

  const stepId = match[1];
  const fieldName = match[2];
  if (!stepId || !fieldName) {
    return undefined;
  }
  const stepOutput = context.stepOutputs[stepId];
  if (!stepOutput || !(fieldName in stepOutput)) {
    return undefined;
  }
  const fieldValue = stepOutput[fieldName];
  if (fieldValue === undefined) {
    return undefined;
  }

  const secret =
    context.secretStepOutputs[stepId]?.includes(fieldName) ??
    looksLikeSecretFieldName(fieldName);

  return {
    value: fieldValue,
    source: "step",
    secret,
    secretValues: secret ? [fieldValue === null ? "null" : String(fieldValue)] : [],
  };
}

function resolveScalarValue(
  value: FlatVariableValue,
  source: VariableExplanation["source"],
  context: RequestResolutionContext,
  seenTokens: Set<string>,
): ResolvedScalarValue {
  if (typeof value !== "string") {
    return {
      value,
      source,
      secret: false,
      secretValues: [],
    };
  }

  if (value.startsWith("$ENV:")) {
    const environmentName = value.slice("$ENV:".length);
    const environmentValue = context.processEnv[environmentName];
    if (environmentValue === undefined) {
      throw new HttpiError(
        "PROCESS_ENV_MISSING",
        `Environment variable ${environmentName} is required but missing.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return {
      value: environmentValue,
      source: "process-env",
      secret: true,
      secretValues: [environmentValue],
    };
  }

  const exactTokenMatch = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  const exactToken = exactTokenMatch?.[1];
  if (exactToken) {
    const resolvedToken = resolveToken(exactToken, context, seenTokens);
    if (!resolvedToken) {
      throw new HttpiError(
        "VARIABLE_UNRESOLVED",
        `Unable to resolve ${exactToken}.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return resolvedToken;
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedToken = resolveToken(token, context, seenTokens);
    if (!resolvedToken) {
      return undefined;
    }

    return resolvedToken.value === null ? "null" : String(resolvedToken.value);
  });
  if (interpolation.unresolved.length > 0) {
    throw new HttpiError(
      "VARIABLE_UNRESOLVED",
      `Unable to resolve ${interpolation.unresolved.join(", ")}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return {
    value: interpolation.value,
    source,
    secret: interpolation.tokens.some(
      (token) => resolveToken(token, context, seenTokens)?.secret ?? false,
    ),
    secretValues: uniqueSecretValues(
      interpolation.tokens.flatMap(
        (token) => resolveToken(token, context, seenTokens)?.secretValues ?? [],
      ),
    ),
  };
}

function collectVariableExplanations(
  context: RequestResolutionContext,
): VariableExplanation[] {
  const keys = new Set<string>();
  for (const sourceValues of [
    context.compiled.configDefaults,
    context.compiled.envValues,
    context.step.request.defaults,
    context.compiled.runInputs,
    context.step.with,
  ]) {
    for (const key of Object.keys(sourceValues)) {
      keys.add(key);
    }
  }

  const explanations = [...keys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => {
      const resolved = resolveToken(key, context, new Set());
      return {
        name: key,
        value: resolved?.value,
        source: resolved?.source ?? "config",
        secret: resolved?.secret,
      };
    });

  const stepOutputExplanations = Object.entries(context.stepOutputs).flatMap(
    ([stepId, values]) =>
      Object.entries(values).map(([fieldName, value]) => ({
        name: `steps.${stepId}.${fieldName}`,
        value,
        source: "step" as const,
        secret:
          context.secretStepOutputs[stepId]?.includes(fieldName) ??
          looksLikeSecretFieldName(fieldName),
      })),
  );

  return [...explanations, ...stepOutputExplanations];
}

function assertStatusExpectation(
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): void {
  const expectedStatus = step.request.expect.status;
  if (expectedStatus === undefined) {
    return;
  }

  if (typeof expectedStatus === "number") {
    if (exchange.response.status !== expectedStatus) {
      throw new HttpiError(
        "EXPECTATION_FAILED",
        `Expected status ${expectedStatus} but received ${exchange.response.status}.`,
        { exitCode: exitCodes.executionFailure },
      );
    }
    return;
  }

  if (!expectedStatus.includes(exchange.response.status)) {
    throw new HttpiError(
      "EXPECTATION_FAILED",
      `Expected one of ${expectedStatus.join(", ")} but received ${exchange.response.status}.`,
      { exitCode: exitCodes.executionFailure },
    );
  }
}

function extractStepOutputs(
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): ExtractedStepOutputs {
  const extractDefinitions = step.request.extract;
  const extractKeys = Object.keys(extractDefinitions);
  if (extractKeys.length === 0) {
    return {
      values: {},
      secretOutputKeys: [],
    };
  }

  const responseBody = exchange.response.bodyText;
  const parsedBody = responseBody ? safeJsonParse(responseBody) : undefined;
  const extractedValues: Record<string, FlatVariableValue> = {};
  const secretOutputKeys = new Set<string>();

  for (const [name, definition] of Object.entries(extractDefinitions)) {
    const extractedValue = readJsonPath(parsedBody, definition.from);
    if (extractedValue === undefined) {
      if (definition.required) {
        throw new HttpiError(
          "EXTRACTION_FAILED",
          `Required extraction ${name} was not found at ${definition.from}.`,
          { exitCode: exitCodes.executionFailure },
        );
      }
      continue;
    }

    extractedValues[name] = coerceToFlatVariableValue(extractedValue);
    if (
      definition.secret ||
      looksLikeSecretFieldName(name) ||
      extractionPathLooksSecret(definition.from)
    ) {
      secretOutputKeys.add(name);
    }
  }

  return {
    values: extractedValues,
    secretOutputKeys: [...secretOutputKeys].sort(),
  };
}

function describeCompiledStep(
  step: CompiledRunSnapshot["steps"][number],
): DescribeRunStep {
  if (step.kind === "parallel") {
    return {
      id: step.id,
      kind: step.kind,
      children: step.steps.map((childStep) => describeCompiledStep(childStep)),
    };
  }

  if (step.kind === "pause") {
    return {
      id: step.id,
      kind: step.kind,
      reason: step.reason,
    };
  }

  return {
    id: step.id,
    kind: step.kind,
    requestId: step.requestId,
  };
}

function selectExplainStep(
  compiled: CompiledRunSnapshot,
  stepId?: string,
): CompiledRequestStep {
  if (stepId) {
    const matchingRequestStep = findRequestStep(compiled, stepId);
    if (!matchingRequestStep) {
      throw new HttpiError(
        "STEP_NOT_FOUND",
        `Step ${stepId} was not found in run ${compiled.runId}.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return matchingRequestStep;
  }

  const firstRequestStep = compiled.steps.find(
    (step): step is CompiledRequestStep => step.kind === "request",
  );
  if (firstRequestStep) {
    return firstRequestStep;
  }

  const parallelRequestStep = compiled.steps.find(
    (step): step is CompiledParallelStep => step.kind === "parallel",
  );
  if (parallelRequestStep?.steps[0]) {
    return parallelRequestStep.steps[0];
  }

  throw new HttpiError(
    "RUN_HAS_NO_REQUESTS",
    `Run ${compiled.runId} has no request steps to explain.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function findRequestStep(
  compiled: CompiledRunSnapshot,
  stepId: string,
): CompiledRequestStep | undefined {
  for (const step of compiled.steps) {
    if (step.kind === "request" && step.id === stepId) {
      return step;
    }

    if (step.kind === "parallel") {
      const childStep = step.steps.find((entry) => entry.id === stepId);
      if (childStep) {
        return childStep;
      }
    }
  }

  return undefined;
}

function findStepStartIndex(session: SessionRecord): number {
  if (!session.nextStepId) {
    return 0;
  }

  const foundIndex = session.compiled.steps.findIndex(
    (step) => step.id === session.nextStepId,
  );
  if (foundIndex === -1) {
    throw new HttpiError(
      "STEP_NOT_FOUND",
      `Session ${session.sessionId} points at missing step ${session.nextStepId}.`,
      { exitCode: exitCodes.unsafeResume },
    );
  }

  return foundIndex;
}

function applyPause(
  session: SessionRecord,
  stepId: string,
  reason: string,
  nextStepId?: string,
): SessionRecord {
  const attempt = nextAttemptNumber(session, stepId);
  const startedSession = startAttempt(session, stepId, "pause", attempt);
  const finalizedSession = finishAttempt(
    startedSession,
    stepId,
    "paused",
    attempt,
    {
      outcome: "paused",
      errorMessage: reason,
    },
  );

  return {
    ...finalizedSession,
    state: "paused",
    nextStepId,
    pausedReason: reason,
    failureReason: undefined,
    updatedAt: toIsoTimestamp(),
  };
}

function nextAttemptNumber(session: SessionRecord, stepId: string): number {
  return getSessionStepRecord(session, stepId).attempts.length + 1;
}

function startAttempt(
  session: SessionRecord,
  stepId: string,
  kind: "request" | "parallel" | "pause",
  attempt: number,
): SessionRecord {
  const stepRecord = getSessionStepRecord(session, stepId);
  return {
    ...session,
    stepRecords: {
      ...session.stepRecords,
      [stepId]: {
        ...stepRecord,
        kind,
        state: "running",
        attempts: [
          ...stepRecord.attempts,
          {
            attempt,
            startedAt: toIsoTimestamp(),
            outcome: "interrupted",
          },
        ],
      },
    },
    state: "running",
    updatedAt: toIsoTimestamp(),
  };
}

function finishAttempt(
  session: SessionRecord,
  stepId: string,
  state: "completed" | "failed" | "paused",
  attempt: number,
  options: {
    outcome: "success" | "failed" | "paused";
    statusCode?: number;
    durationMs?: number;
    errorMessage?: string;
    artifacts?: StepArtifactSummary;
  },
): SessionRecord {
  const stepRecord = getSessionStepRecord(session, stepId);
  const attempts = stepRecord.attempts.map((entry) =>
    entry.attempt === attempt
      ? {
          ...entry,
          finishedAt: toIsoTimestamp(),
          durationMs: options.durationMs,
          outcome: options.outcome,
          statusCode: options.statusCode,
          errorMessage: options.errorMessage,
          artifacts: options.artifacts,
        }
      : entry,
  );

  return {
    ...session,
    stepRecords: {
      ...session.stepRecords,
      [stepId]: {
        ...stepRecord,
        state,
        attempts,
        errorMessage: options.errorMessage,
      },
    },
    updatedAt: toIsoTimestamp(),
  };
}

async function loadProjectContext(
  options: EngineOptions,
): Promise<LoadedProjectContext> {
  const rootDir = await findProjectRoot(options);
  const project = await loadProjectFiles(rootDir);
  return {
    rootDir,
    project,
  };
}

async function writeTemplateIfMissing(
  filePath: string,
  content: string,
): Promise<string[]> {
  if (await fileExists(filePath)) {
    return [];
  }

  await writeUtf8File(filePath, content);
  return [filePath];
}

function safeJsonParse(value: string): JsonValue | undefined {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function readJsonPath(value: JsonValue | undefined, path: string): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (path === "$") {
    return value;
  }

  if (!path.startsWith("$.")) {
    return undefined;
  }

  const segments = path.slice(2).split(".");
  let currentValue: unknown = value;

  for (const segment of segments) {
    const segmentMatch = segment.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
    if (!segmentMatch) {
      return undefined;
    }

    const propertyName = segmentMatch[1];
    const indexValue = segmentMatch[2];
    if (!propertyName) {
      return undefined;
    }

    if (
      typeof currentValue !== "object" ||
      currentValue === null ||
      Array.isArray(currentValue)
    ) {
      return undefined;
    }

    const record = currentValue as Record<string, unknown>;
    currentValue = record[propertyName];

    if (indexValue !== undefined) {
      if (!Array.isArray(currentValue)) {
        return undefined;
      }

      currentValue = currentValue[Number(indexValue)];
    }
  }

  return currentValue;
}

function coerceToFlatVariableValue(value: unknown): FlatVariableValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  return JSON.stringify(value);
}

function inferContentTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  if (extension === ".xml") {
    return "application/xml";
  }
  if (extension === ".csv") {
    return "text/csv";
  }

  return "application/octet-stream";
}

function isTextExtension(filePath: string): boolean {
  return [".json", ".txt", ".yaml", ".yml", ".xml", ".csv", ".md"].includes(
    extname(filePath).toLowerCase(),
  );
}

function resolveOptionalNumberVariable(
  value: FlatVariableValue | undefined,
): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function uniqueSecretValues(secretValues: string[]): string[] {
  return [
    ...new Set(secretValues.filter((secretValue) => secretValue.length > 0)),
  ];
}

function validateTimeoutMs(
  stepId: string,
  requestId: string,
  timeoutMs: number,
): number {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  throw new HttpiError(
    "REQUEST_TIMEOUT_INVALID",
    `Request ${requestId} step ${stepId} resolved an invalid timeoutMs value (${timeoutMs}). timeoutMs must be a positive number.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function collectSecretOutputValues(outputs: ExtractedStepOutputs): string[] {
  return uniqueSecretValues(
    outputs.secretOutputKeys.flatMap((key) => {
      const value = outputs.values[key];
      return value === undefined ? [] : [value === null ? "null" : String(value)];
    }),
  );
}

function redactResolvedRequestModel(
  request: ResolvedRequestModel,
): ResolvedRequestModel {
  return {
    ...request,
    url: redactText(request.url, request.secretValues),
    headers: redactHeaders(request.headers, [], request.secretValues),
    body:
      request.body?.text !== undefined
        ? {
            ...request.body,
            text: redactText(request.body.text, request.secretValues),
          }
        : request.body,
    secretValues: [],
  };
}

function redactVariableExplanations(
  variables: VariableExplanation[],
): VariableExplanation[] {
  return variables.map((variable) =>
    variable.secret ? { ...variable, value: redactedValue } : variable,
  );
}

function redactFlatVariableMap(
  values: FlatVariableMap,
  secretKeys: Iterable<string> = [],
): FlatVariableMap {
  const secretKeySet = new Set(secretKeys);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      secretKeySet.has(key) || looksLikeSecretFieldName(key)
        ? redactedValue
        : value,
    ]),
  );
}

function redactSessionForOutput(session: SessionRecord): SessionRecord {
  return {
    ...session,
    compiled: {
      ...session.compiled,
      configDefaults: redactFlatVariableMap(session.compiled.configDefaults),
      envValues: redactFlatVariableMap(session.compiled.envValues),
      runInputs: redactFlatVariableMap(session.compiled.runInputs),
      steps: session.compiled.steps.map((step) => redactCompiledStep(step)),
    },
    stepRecords: Object.fromEntries(
      Object.entries(session.stepRecords).map(([stepId, stepRecord]) => [
        stepId,
        {
          ...stepRecord,
          output: redactFlatVariableMap(
            stepRecord.output,
            stepRecord.secretOutputKeys ?? [],
          ),
        },
      ]),
    ),
    stepOutputs: Object.fromEntries(
      Object.entries(session.stepOutputs).map(([stepId, values]) => [
        stepId,
        redactFlatVariableMap(
          values,
          session.stepRecords[stepId]?.secretOutputKeys ?? [],
        ),
      ]),
    ),
  };
}

function extractionPathLooksSecret(path: string): boolean {
  if (!path.startsWith("$.")) {
    return false;
  }

  return path
    .slice(2)
    .split(".")
    .some((segment) => {
      const segmentMatch = segment.match(/^([^[\]]+)/);
      return segmentMatch?.[1]
        ? looksLikeSecretFieldName(segmentMatch[1])
        : false;
    });
}

function collectSecretStepOutputs(
  stepRecords: Record<string, SessionStepRecord>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(stepRecords).flatMap(([stepId, stepRecord]) =>
      stepRecord.secretOutputKeys && stepRecord.secretOutputKeys.length > 0
        ? [[stepId, [...stepRecord.secretOutputKeys]]]
        : [],
    ),
  );
}

function redactCompiledStep(
  step: CompiledRunSnapshot["steps"][number],
): CompiledRunSnapshot["steps"][number] {
  if (step.kind === "parallel") {
    return {
      ...step,
      steps: step.steps.map((childStep) => ({
        ...childStep,
        with: redactFlatVariableMap(childStep.with),
        request: {
          ...childStep.request,
          defaults: redactFlatVariableMap(childStep.request.defaults),
        },
      })),
    };
  }

  if (step.kind === "pause") {
    return step;
  }

  return {
    ...step,
    with: redactFlatVariableMap(step.with),
    request: {
      ...step.request,
      defaults: redactFlatVariableMap(step.request.defaults),
    },
  };
}

export function resolveTemplateValueForTesting(
  value: string,
  context: RequestResolutionContext,
): {
  value: FlatVariableValue;
  secretValues: string[];
} {
  return resolveTemplateValue(value, context);
}

export function collectVariableExplanationsForTesting(
  context: RequestResolutionContext,
): VariableExplanation[] {
  return collectVariableExplanations(context);
}

export function extractStepOutputsForTesting(
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): ExtractedStepOutputs {
  return extractStepOutputs(step, exchange);
}

export function redactSessionForOutputForTesting(
  session: SessionRecord,
): SessionRecord {
  return redactSessionForOutput(session);
}

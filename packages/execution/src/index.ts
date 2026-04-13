import type {
  ArtifactListResult,
  ArtifactReadResult,
  DescribeRequestResult,
  DescribeRunResult,
  Diagnostic,
  EnrichedDiagnostic,
  ExecutionResult,
  ExplainVariablesResult,
  FlatVariableMap,
  ListDefinitionsResult,
  SessionStateResult,
} from "@exit-zero-labs/httpi-contracts";
import { isDiagnostic } from "@exit-zero-labs/httpi-contracts";
import {
  compileRequestSnapshot,
  compileRunSnapshot,
  enrichDiagnosticsFromFiles,
  finalizeDiagnostic,
  findProjectRoot,
} from "@exit-zero-labs/httpi-definitions";
import {
  createSessionRecord,
  detectDefinitionDrift,
  listArtifacts,
  listSessions,
  readArtifact,
  readSession,
  readStreamChunks,
  requestSessionCancel,
  type SessionCancelRecord,
  type StreamChunkRange,
  type StreamChunksResult,
  touchSession,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";

export { installSignalCancelHandler } from "@exit-zero-labs/httpi-runtime";

import {
  applyMask,
  resolveSnapshotPath,
  acceptSnapshot as writeSnapshotFile,
} from "./snapshot.js";

export interface AcceptSnapshotResult {
  sessionId: string;
  stepId: string;
  snapshotPath: string;
  wrote: boolean;
}

export async function acceptSnapshotForStep(
  sessionId: string,
  stepId: string,
  options: EngineOptions = {},
): Promise<AcceptSnapshotResult> {
  const rootDir = await findProjectRoot(options);
  const session = await readSession(rootDir, sessionId);
  const stepRecord = session.stepRecords[stepId];
  if (!stepRecord) {
    throw new HttpiError(
      "STEP_NOT_FOUND",
      `Step ${stepId} is not present in session ${sessionId}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const compiledStep = session.compiled.steps.find((s) =>
    s.kind === "request" ? s.id === stepId : false,
  );
  if (!compiledStep || compiledStep.kind !== "request") {
    throw new HttpiError(
      "SNAPSHOT_STEP_NOT_REQUEST",
      `Step ${stepId} is not a request step.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const body = compiledStep.request.expect?.body;
  if (!body || body.kind !== "snapshot" || !body.file) {
    throw new HttpiError(
      "SNAPSHOT_NOT_DECLARED",
      `Step ${stepId} does not declare expect.body.kind: snapshot with a file:.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  // Load the latest response body from the artifact manifest.
  const lastAttempt = stepRecord.attempts[stepRecord.attempts.length - 1];
  const bodyRel = lastAttempt?.artifacts?.bodyPath;
  if (!bodyRel) {
    throw new HttpiError(
      "SNAPSHOT_BODY_MISSING",
      `No response body artifact captured for step ${stepId}; re-run with capture.responseBody: full.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const artifact = await readArtifact(rootDir, sessionId, bodyRel);
  const text = artifact.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const masks = (body.mask ?? []).map((m) => m.path);
  const masked = applyMask(parsed, masks);
  const snapshotPath = resolveSnapshotPath(body.file, {
    projectRoot: rootDir,
    ...(compiledStep.request.filePath
      ? { requestFilePath: compiledStep.request.filePath }
      : {}),
  });
  await writeSnapshotFile(snapshotPath, masked);
  return { sessionId, stepId, snapshotPath, wrote: true };
}

import { exitCodes, HttpiError } from "@exit-zero-labs/httpi-shared";
import { describeCompiledStep, selectExplainStep } from "./describe.js";
import {
  buildCompileOptions,
  getSingleRequestStep,
  loadProjectContext,
} from "./project-context.js";
import {
  redactResolvedRequestModel,
  redactSessionForOutput,
  redactVariableExplanations,
} from "./redaction.js";
import { materializeRequest } from "./request-resolution.js";
import { executeSession } from "./session-execution.js";
import type { EngineOptions } from "./types.js";

export { initProject } from "./project-init.js";
export type { EngineOptions, InitProjectResult } from "./types.js";

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
  diagnostics: EnrichedDiagnostic[];
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
  return withEnrichedDiagnosticErrors(async () => {
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
  });
}

export async function describeRun(
  runId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<DescribeRunResult> {
  return withEnrichedDiagnosticErrors(async () => {
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
  });
}

export async function runRequest(
  requestId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<ExecutionResult> {
  return withEnrichedDiagnosticErrors(async () => {
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
  });
}

export async function runRun(
  runId: string,
  options: EngineOptions & {
    envId?: string | undefined;
    overrides?: FlatVariableMap | undefined;
  } = {},
): Promise<ExecutionResult> {
  return withEnrichedDiagnosticErrors(async () => {
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
  });
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

  const driftDiagnostics = await enrichDiagnosticsFromFiles(
    await detectDefinitionDrift(rootDir, session),
  );
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
  const diagnostics = await enrichDiagnosticsFromFiles(
    await detectDefinitionDrift(rootDir, session),
  );
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

export interface CancelSessionResult {
  sessionId: string;
  state: string;
  cancel: SessionCancelRecord;
}

export async function cancelSessionRun(
  sessionId: string,
  options: EngineOptions & { reason?: string; source?: string } = {},
): Promise<CancelSessionResult> {
  const rootDir = await findProjectRoot(options);
  const session = await readSession(rootDir, sessionId);
  const cancel = await requestSessionCancel(rootDir, sessionId, {
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.source ? { source: options.source } : {}),
  });
  // If the session is still runnable, mark it interrupted so consumers see a
  // terminal state even if no executor is actively polling the marker.
  if (
    session.state === "created" ||
    session.state === "running" ||
    session.state === "paused"
  ) {
    const next = touchSession(session, "interrupted");
    await writeSession(rootDir, next);
    return { sessionId, state: next.state, cancel };
  }
  return { sessionId, state: session.state, cancel };
}

export async function getSessionStreamChunks(
  sessionId: string,
  stepId: string,
  options: EngineOptions & { range?: StreamChunkRange | undefined } = {},
): Promise<StreamChunksResult> {
  const rootDir = await findProjectRoot(options);
  return readStreamChunks(rootDir, sessionId, stepId, options.range);
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
  return withEnrichedDiagnosticErrors(async () => {
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
  });
}

async function withEnrichedDiagnosticErrors<TResult>(
  action: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await action();
  } catch (error) {
    throw await enrichHttpiErrorDiagnostics(error);
  }
}

async function enrichHttpiErrorDiagnostics(error: unknown): Promise<unknown> {
  if (!(error instanceof HttpiError) || !Array.isArray(error.details)) {
    return error;
  }

  const diagnostics = error.details.filter(isDiagnostic);
  if (diagnostics.length !== error.details.length || diagnostics.length === 0) {
    return error;
  }

  let enrichedDiagnostics: Diagnostic[];
  try {
    enrichedDiagnostics = await enrichDiagnosticsFromFiles(diagnostics);
  } catch {
    enrichedDiagnostics = diagnostics.map((diagnostic) =>
      finalizeDiagnostic(diagnostic),
    );
  }

  return new HttpiError(error.code, error.message, {
    cause: error.cause,
    exitCode: error.exitCode,
    details: enrichedDiagnostics,
  });
}

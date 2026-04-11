import type {
  ArtifactListResult,
  ArtifactReadResult,
  DescribeRequestResult,
  DescribeRunResult,
  Diagnostic,
  ExecutionResult,
  ExplainVariablesResult,
  FlatVariableMap,
  ListDefinitionsResult,
  SessionStateResult,
} from "@exit-zero-labs/httpi-contracts";
import {
  compileRequestSnapshot,
  compileRunSnapshot,
  findProjectRoot,
} from "@exit-zero-labs/httpi-definitions";
import {
  createSessionRecord,
  detectDefinitionDrift,
  listArtifacts,
  listSessions,
  readArtifact,
  readSession,
} from "@exit-zero-labs/httpi-runtime";
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

  const driftDiagnostics = await detectDefinitionDrift(rootDir, session);
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
  const diagnostics = await detectDefinitionDrift(rootDir, session);
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

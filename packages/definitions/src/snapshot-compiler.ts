import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CompiledAuthBlock,
  CompiledHeaderBlock,
  CompiledPauseStep,
  CompiledRequestDefinition,
  CompiledRequestStep,
  CompiledRunSnapshot,
  CompiledRunStep,
  EnvironmentFile,
  FlatVariableMap,
  ProjectFiles,
  RequestFile,
  RunRequestStepDefinition,
  RunStepDefinition,
} from "@exit-zero-labs/httpi-contracts";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import {
  assertPathWithin,
  exitCodes,
  HttpiError,
  hashProcessEnvValue,
  resolveFromRoot,
  sha256Hex,
  toIsoTimestamp,
} from "@exit-zero-labs/httpi-shared";

export interface CompileSnapshotOptions {
  envId?: string | undefined;
  overrides?: FlatVariableMap | undefined;
  processEnv?: Record<string, string | undefined> | undefined;
  stepId?: string | undefined;
}

export function assertProjectIsValid(project: ProjectFiles): void {
  const errors = project.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (errors.length === 0) {
    return;
  }

  throw new HttpiError(
    "PROJECT_INVALID",
    "Project definitions contain validation errors.",
    {
      exitCode: exitCodes.validationFailure,
      details: errors,
    },
  );
}

export function compileRunSnapshot(
  project: ProjectFiles,
  runId: string,
  options: CompileSnapshotOptions = {},
): CompiledRunSnapshot {
  assertProjectIsValid(project);

  const runFile = project.runs[runId];
  if (!runFile) {
    throw new HttpiError("RUN_NOT_FOUND", `Run ${runId} was not found.`, {
      exitCode: exitCodes.validationFailure,
    });
  }

  const envFile = resolveEnvironmentFile(
    project,
    options.envId ?? runFile.definition.env,
  );
  const runInputs = {
    ...(runFile.definition.inputs ?? {}),
    ...(options.overrides ?? {}),
  };
  const overrideKeys = Object.keys(options.overrides ?? {});

  const definitionHashes: Record<string, string> = {
    [project.configPath]: project.configHash,
    [envFile.filePath]: envFile.hash,
    [runFile.filePath]: runFile.hash,
  };

  const compiledSteps = compileRunSteps(
    project,
    runFile.definition.steps,
    definitionHashes,
  );

  const compiledSnapshot: CompiledRunSnapshot = {
    schemaVersion,
    source: "run",
    runId,
    title: runFile.title,
    sourceFilePath: runFile.filePath,
    envId: envFile.id,
    configPath: project.configPath,
    configHash: project.configHash,
    configDefaults: project.config.defaults,
    capture: project.config.capture,
    envPath: envFile.filePath,
    envHash: envFile.hash,
    envValues: envFile.definition.values,
    runInputs,
    overrideKeys,
    definitionHashes,
    steps: compiledSteps,
    envGuards: envFile.definition.guards,
    createdAt: toIsoTimestamp(),
  };
  compiledSnapshot.processEnvHashes = collectProcessEnvHashes(
    compiledSnapshot,
    options.processEnv ?? process.env,
  );
  return compiledSnapshot;
}

export function compileRequestSnapshot(
  project: ProjectFiles,
  requestId: string,
  options: CompileSnapshotOptions = {},
): CompiledRunSnapshot {
  assertProjectIsValid(project);

  const requestFile = project.requests[requestId];
  if (!requestFile) {
    throw new HttpiError(
      "REQUEST_NOT_FOUND",
      `Request ${requestId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const envFile = resolveEnvironmentFile(project, options.envId);
  const definitionHashes: Record<string, string> = {
    [project.configPath]: project.configHash,
    [envFile.filePath]: envFile.hash,
    [requestFile.filePath]: requestFile.hash,
  };
  const overrideKeys = Object.keys(options.overrides ?? {});

  const compiledRequest = compileRequestDefinition(
    project,
    requestFile,
    definitionHashes,
  );
  const stepId = options.stepId ?? "request";
  const step: CompiledRequestStep = {
    kind: "request",
    id: stepId,
    requestId,
    with: options.overrides ?? {},
    request: compiledRequest,
  };

  const compiledSnapshot: CompiledRunSnapshot = {
    schemaVersion,
    source: "request",
    runId: requestId,
    title: requestFile.title,
    sourceFilePath: requestFile.filePath,
    envId: envFile.id,
    configPath: project.configPath,
    configHash: project.configHash,
    configDefaults: project.config.defaults,
    capture: project.config.capture,
    envPath: envFile.filePath,
    envHash: envFile.hash,
    envValues: envFile.definition.values,
    runInputs: options.overrides ?? {},
    overrideKeys,
    definitionHashes,
    steps: [step],
    envGuards: envFile.definition.guards,
    createdAt: toIsoTimestamp(),
  };
  compiledSnapshot.processEnvHashes = collectProcessEnvHashes(
    compiledSnapshot,
    options.processEnv ?? process.env,
  );
  return compiledSnapshot;
}

function compileRunSteps(
  project: ProjectFiles,
  steps: RunStepDefinition[],
  definitionHashes: Record<string, string>,
): CompiledRunStep[] {
  return steps.map((step) => {
    if (step.kind === "pause") {
      const compiledPauseStep: CompiledPauseStep = {
        kind: "pause",
        id: step.id,
        reason: step.reason,
      };
      return compiledPauseStep;
    }

    if (step.kind === "parallel") {
      return {
        kind: "parallel",
        id: step.id,
        steps: step.steps.map((childStep) =>
          compileRunRequestStep(project, childStep, definitionHashes),
        ),
      };
    }

    if (step.kind === "pollUntil") {
      const requestStep = compileRunRequestStep(
        project,
        {
          kind: "request",
          id: `${step.id}-poll`,
          uses: step.request.uses,
          with: step.request.with,
        },
        definitionHashes,
      );
      return {
        kind: "pollUntil",
        id: step.id,
        requestStep,
        until: step.until,
        intervalMs: step.intervalMs,
        maxAttempts: step.maxAttempts ?? 60,
        timeoutMs: step.timeoutMs,
      };
    }

    return compileRunRequestStep(project, step, definitionHashes);
  });
}

function compileRunRequestStep(
  project: ProjectFiles,
  step: RunRequestStepDefinition,
  definitionHashes: Record<string, string>,
): CompiledRequestStep {
  const requestFile = project.requests[step.uses];
  if (!requestFile) {
    throw new HttpiError(
      "REQUEST_NOT_FOUND",
      `Request ${step.uses} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return {
    kind: "request",
    id: step.id,
    requestId: requestFile.id,
    with: step.with ?? {},
    request: compileRequestDefinition(project, requestFile, definitionHashes),
    retry: step.retry,
    idempotency: step.idempotency,
  };
}

function compileRequestDefinition(
  project: ProjectFiles,
  requestFile: RequestFile,
  definitionHashes: Record<string, string>,
): CompiledRequestDefinition {
  const headerBlocks = (requestFile.definition.uses?.headers ?? []).map(
    (headerBlockId) => {
      const headerBlock = project.headerBlocks[headerBlockId];
      if (!headerBlock) {
        throw new HttpiError(
          "HEADER_BLOCK_NOT_FOUND",
          `Header block ${headerBlockId} was not found.`,
          { exitCode: exitCodes.validationFailure },
        );
      }

      definitionHashes[headerBlock.filePath] = headerBlock.hash;
      const compiledHeaderBlock: CompiledHeaderBlock = {
        id: headerBlock.id,
        filePath: headerBlock.filePath,
        hash: headerBlock.hash,
        headers: headerBlock.definition.headers,
      };
      return compiledHeaderBlock;
    },
  );

  let authBlock: CompiledAuthBlock | undefined;
  if (requestFile.definition.uses?.auth) {
    const authBlockFile = project.authBlocks[requestFile.definition.uses.auth];
    if (!authBlockFile) {
      throw new HttpiError(
        "AUTH_BLOCK_NOT_FOUND",
        `Auth block ${requestFile.definition.uses.auth} was not found.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    definitionHashes[authBlockFile.filePath] = authBlockFile.hash;
    authBlock = {
      id: authBlockFile.id,
      filePath: authBlockFile.filePath,
      hash: authBlockFile.hash,
      auth: authBlockFile.definition.auth,
    };
  }

  definitionHashes[requestFile.filePath] = requestFile.hash;
  trackRequestBodyFileHash(project, requestFile, definitionHashes);

  return {
    requestId: requestFile.id,
    title: requestFile.title,
    filePath: requestFile.filePath,
    hash: requestFile.hash,
    method: requestFile.definition.method,
    url: requestFile.definition.url,
    defaults: requestFile.definition.defaults ?? {},
    headers: requestFile.definition.headers ?? {},
    headerBlocks,
    auth: requestFile.definition.auth,
    authBlock,
    body: requestFile.definition.body,
    response: requestFile.definition.response,
    expect: requestFile.definition.expect ?? {},
    extract: requestFile.definition.extract ?? {},
    timeoutMs: requestFile.definition.timeoutMs,
    cancel: requestFile.definition.cancel,
  };
}

function trackRequestBodyFileHash(
  project: ProjectFiles,
  requestFile: RequestFile,
  definitionHashes: Record<string, string>,
): void {
  const bodyDefinition = requestFile.definition.body;
  if (!bodyDefinition || !("file" in bodyDefinition)) {
    return;
  }

  const trackedRoot = dirname(project.configPath);
  const bodiesDirectory = resolveFromRoot(trackedRoot, "bodies");
  const bodyFilePath = resolveFromRoot(bodiesDirectory, bodyDefinition.file);
  try {
    assertPathWithin(bodiesDirectory, bodyFilePath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyFileDiagnosticError(
        requestFile.filePath,
        error.message,
        "Update body.file so it points to a real tracked file inside httpi/bodies.",
      );
    }

    throw error;
  }

  const bodyFileStats = readFileStatsIfPresent(bodyFilePath);
  if (!bodyFileStats) {
    return;
  }
  if (bodyFileStats.isSymbolicLink() || !bodyFileStats.isFile()) {
    return;
  }

  const resolvedBodiesDirectory = realpathSync(bodiesDirectory);
  const resolvedBodyFilePath = realpathSync(bodyFilePath);
  try {
    assertPathWithin(resolvedBodiesDirectory, resolvedBodyFilePath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyFileDiagnosticError(
        requestFile.filePath,
        error.message,
        "Update body.file so it points to a real tracked file inside httpi/bodies.",
      );
    }

    throw error;
  }
  definitionHashes[bodyFilePath] = sha256Hex(
    readFileSync(resolvedBodyFilePath),
  );
}

function readFileStatsIfPresent(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function buildBodyFileDiagnosticError(
  filePath: string,
  message: string,
  hint: string,
): HttpiError {
  return new HttpiError("BODY_FILE_PATH_INVALID", message, {
    exitCode: exitCodes.validationFailure,
    details: [
      {
        level: "error" as const,
        code: "BODY_FILE_PATH_INVALID",
        message,
        hint,
        filePath,
        path: "body.file",
      },
    ],
  });
}

function collectProcessEnvHashes(
  compiledSnapshot: CompiledRunSnapshot,
  processEnv: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const processEnvNames = [
    ...collectProcessEnvReferenceNames(compiledSnapshot),
  ];
  if (processEnvNames.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    processEnvNames
      .sort((left, right) => left.localeCompare(right))
      .map((environmentName) => [
        environmentName,
        hashProcessEnvValue(processEnv[environmentName]),
      ]),
  );
}

function collectProcessEnvReferenceNames(value: unknown): Set<string> {
  const environmentNames = new Set<string>();
  visitCompiledValue(value, (currentValue) => {
    if (typeof currentValue !== "string" || !currentValue.startsWith("$ENV:")) {
      return;
    }

    environmentNames.add(currentValue.slice("$ENV:".length));
  });
  return environmentNames;
}

function visitCompiledValue(
  value: unknown,
  visitor: (currentValue: unknown) => void,
): void {
  visitor(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitCompiledValue(entry, visitor);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const entry of Object.values(value)) {
    visitCompiledValue(entry, visitor);
  }
}

function resolveEnvironmentFile(
  project: ProjectFiles,
  requestedEnvId: string | undefined,
): EnvironmentFile {
  const envId = requestedEnvId ?? project.config.defaultEnv;
  if (!envId) {
    throw new HttpiError(
      "ENV_NOT_SPECIFIED",
      "No environment was provided and the project has no defaultEnv.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  const envFile = project.environments[envId];
  if (!envFile) {
    throw new HttpiError(
      "ENV_NOT_FOUND",
      `Environment ${envId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return envFile;
}

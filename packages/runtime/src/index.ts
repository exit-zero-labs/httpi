import { dirname, extname, join, resolve } from "node:path";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { parseDocument } from "yaml";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import type {
  ArtifactManifest,
  ArtifactManifestEntry,
  Diagnostic,
  SessionEvent,
  SessionRecord,
  SessionStepRecord,
  StepArtifactSummary,
  StepState,
} from "@exit-zero-labs/httpi-contracts";
import {
  HttpiError,
  appendJsonLine,
  assertPathWithin,
  createLockOwnerId,
  createSessionId,
  ensureDir,
  exitCodes,
  fileExists,
  readJsonFile,
  readUtf8File,
  redactText,
  removeFileIfExists,
  resolveFromRoot,
  runtimeDirectoryName,
  sanitizeFileSegment,
  sha256Hex,
  stableStringify,
  toIsoTimestamp,
  writeFileAtomic,
  writeJsonFileAtomic,
} from "@exit-zero-labs/httpi-shared";

export interface RuntimePaths {
  rootDir: string;
  runtimeDir: string;
  sessionsDir: string;
  responsesDir: string;
  secretsPath: string;
}

export interface SessionLockHandle {
  sessionId: string;
  lockFilePath: string;
  ownerId: string;
}

export interface StepArtifactWriteInput {
  stepId: string;
  attempt: number;
  requestSummary?: unknown;
  responseMetadata?: unknown;
  bodyText?: string | undefined;
  bodyBase64?: string | undefined;
  contentType?: string | undefined;
}

const serializedFileOperations = new Map<string, Promise<void>>();
const runtimeDirectoryMode = 0o700;
const runtimeFileMode = 0o600;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function ensureRuntimePaths(
  projectRoot: string,
): Promise<RuntimePaths> {
  const runtimeDir = resolveFromRoot(projectRoot, runtimeDirectoryName);
  const sessionsDir = resolveFromRoot(runtimeDir, "sessions");
  const responsesDir = resolveFromRoot(runtimeDir, "responses");
  const secretsPath = resolveFromRoot(runtimeDir, "secrets.yaml");

  await Promise.all([
    ensureDir(runtimeDir, runtimeDirectoryMode),
    ensureDir(sessionsDir, runtimeDirectoryMode),
    ensureDir(responsesDir, runtimeDirectoryMode),
  ]);
  await Promise.all([
    chmod(runtimeDir, runtimeDirectoryMode),
    chmod(sessionsDir, runtimeDirectoryMode),
    chmod(responsesDir, runtimeDirectoryMode),
  ]);

  return {
    rootDir: resolve(projectRoot),
    runtimeDir,
    sessionsDir,
    responsesDir,
    secretsPath,
  };
}

export function createSessionRecord(
  compiled: SessionRecord["compiled"],
  sessionId = createSessionId(compiled.source),
): SessionRecord {
  const createdAt = toIsoTimestamp();
  const stepRecords: Record<string, SessionStepRecord> = {};

  for (const step of compiled.steps) {
    if (step.kind === "parallel") {
      stepRecords[step.id] = {
        stepId: step.id,
        kind: "parallel",
        state: "pending",
        attempts: [],
        output: {},
        secretOutputKeys: [],
        childStepIds: step.steps.map((childStep) => childStep.id),
      };

      for (const childStep of step.steps) {
        stepRecords[childStep.id] = {
          stepId: childStep.id,
          kind: "request",
          requestId: childStep.requestId,
          state: "pending",
          attempts: [],
          output: {},
          secretOutputKeys: [],
        };
      }

      continue;
    }

    stepRecords[step.id] = {
      stepId: step.id,
      kind: step.kind,
      requestId: step.kind === "request" ? step.requestId : undefined,
      state: "pending",
      attempts: [],
      output: {},
      secretOutputKeys: [],
    };
  }

  const runtimeRoot = resolve(
    dirname(dirname(compiled.configPath)),
    runtimeDirectoryName,
  );
  const responsesDir = resolveFromRoot(runtimeRoot, "responses", sessionId);

  return {
    schemaVersion,
    sessionId,
    source: compiled.source,
    runId: compiled.runId,
    envId: compiled.envId,
    state: "created",
    nextStepId: compiled.steps[0]?.id,
    compiled,
    stepRecords,
    stepOutputs: {},
    artifactManifestPath: resolveFromRoot(responsesDir, "manifest.json"),
    eventLogPath: resolveFromRoot(responsesDir, "events.jsonl"),
    createdAt,
    updatedAt: createdAt,
  };
}

export async function writeSession(
  projectRoot: string,
  session: SessionRecord,
): Promise<void> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, session.sessionId);
  await writeJsonFileAtomic(sessionPaths.sessionPath, session, runtimeFileMode);
}

export async function readSession(
  projectRoot: string,
  sessionId: string,
): Promise<SessionRecord> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  if (!(await fileExists(sessionPaths.sessionPath))) {
    throw new HttpiError(
      "SESSION_NOT_FOUND",
      `Session ${sessionId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const session = await readJsonFile<SessionRecord>(sessionPaths.sessionPath);
  assertValidSessionRecord(session, sessionId);
  return session;
}

export async function listSessions(
  projectRoot: string,
): Promise<SessionRecord[]> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const entries = await readdir(runtimePaths.sessionsDir, {
    withFileTypes: true,
  });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));

  const sessions = await Promise.all(
    sessionFiles.map((entry) =>
      readJsonFile<SessionRecord>(
        resolveFromRoot(runtimePaths.sessionsDir, entry.name),
      ),
    ),
  );

  return sessions.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function acquireSessionLock(
  projectRoot: string,
  sessionId: string,
): Promise<SessionLockHandle> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  const ownerId = createLockOwnerId();
  const handle = await open(sessionPaths.lockFilePath, "wx", runtimeFileMode).catch(
    (error: unknown) => {
      if (isFileExistsError(error)) {
        throw new HttpiError(
          "SESSION_LOCKED",
        `Session ${sessionId} is already locked by another process.`,
        {
          exitCode: exitCodes.unsafeResume,
          cause: error,
        },
      );
    }

      throw error;
    },
  );

  try {
    await handle.writeFile(
      `${stableStringify({
        ownerId,
        acquiredAt: toIsoTimestamp(),
      })}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }

  return {
    sessionId,
    lockFilePath: sessionPaths.lockFilePath,
    ownerId,
  };
}

export async function releaseSessionLock(
  lockHandle: SessionLockHandle,
): Promise<void> {
  await removeFileIfExists(lockHandle.lockFilePath);
}

export async function appendSessionEvent(
  projectRoot: string,
  session: SessionRecord,
  event: SessionEvent,
): Promise<void> {
  await ensureSessionArtifactRoot(projectRoot, session);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, session.sessionId);
  await withSerializedFileOperation(sessionPaths.eventLogPath, async () => {
    await appendJsonLine(sessionPaths.eventLogPath, event, runtimeFileMode);
  });
}

export async function writeStepArtifacts(
  projectRoot: string,
  session: SessionRecord,
  input: StepArtifactWriteInput,
): Promise<StepArtifactSummary> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, session.sessionId);
  return withSerializedFileOperation(sessionPaths.manifestPath, async () => {
    await ensureSessionArtifactRoot(projectRoot, session);
    const artifactRoot = sessionPaths.artifactRoot;
    const attemptDirectory = resolveFromRoot(
      artifactRoot,
      "steps",
      sanitizeFileSegment(input.stepId),
      `attempt-${input.attempt}`,
    );
    await ensureDir(attemptDirectory, runtimeDirectoryMode);
    await chmod(attemptDirectory, runtimeDirectoryMode);

    const summary: StepArtifactSummary = {};
    const manifest = await readArtifactManifest(projectRoot, session.sessionId);

    if (input.requestSummary !== undefined) {
      const relativePath = buildRelativeArtifactPath(
        input.stepId,
        input.attempt,
        "request.summary.json",
      );
      const absolutePath = resolveFromRoot(artifactRoot, relativePath);
      await writeJsonFileAtomic(
        absolutePath,
        input.requestSummary,
        runtimeFileMode,
      );
      summary.requestSummaryPath = relativePath;
      manifest.entries.push({
        schemaVersion,
        sessionId: session.sessionId,
        stepId: input.stepId,
        attempt: input.attempt,
        kind: "request.summary",
        relativePath,
        contentType: "application/json",
      });
    }

    if (input.responseMetadata !== undefined) {
      const relativePath = buildRelativeArtifactPath(
        input.stepId,
        input.attempt,
        "response.meta.json",
      );
      const absolutePath = resolveFromRoot(artifactRoot, relativePath);
      await writeJsonFileAtomic(
        absolutePath,
        input.responseMetadata,
        runtimeFileMode,
      );
      summary.responseMetadataPath = relativePath;
      manifest.entries.push({
        schemaVersion,
        sessionId: session.sessionId,
        stepId: input.stepId,
        attempt: input.attempt,
        kind: "response.meta",
        relativePath,
        contentType: "application/json",
      });
    }

    if (input.bodyText !== undefined || input.bodyBase64 !== undefined) {
      const fileName = selectBodyFileName(input.contentType);
      const relativePath = buildRelativeArtifactPath(
        input.stepId,
        input.attempt,
        fileName,
      );
      const absolutePath = resolveFromRoot(artifactRoot, relativePath);
      await ensureDir(dirname(absolutePath), runtimeDirectoryMode);

      if (input.bodyBase64 !== undefined) {
        await writeFileAtomic(
          absolutePath,
          Buffer.from(input.bodyBase64, "base64"),
          { mode: runtimeFileMode },
        );
      } else if (input.bodyText !== undefined) {
        await writeFileAtomic(absolutePath, input.bodyText, {
          mode: runtimeFileMode,
        });
      }

      summary.bodyPath = relativePath;
      manifest.entries.push({
        schemaVersion,
        sessionId: session.sessionId,
        stepId: input.stepId,
        attempt: input.attempt,
        kind: "body",
        relativePath,
        contentType: input.contentType,
      });
    }

    manifest.entries = sortArtifactManifestEntries(manifest.entries);
    await writeJsonFileAtomic(
      sessionPaths.manifestPath,
      manifest,
      runtimeFileMode,
    );
    return summary;
  });
}

export async function listArtifacts(
  projectRoot: string,
  sessionId: string,
  stepId?: string,
): Promise<ArtifactManifestEntry[]> {
  assertValidSessionId(sessionId);
  const session = await readSession(projectRoot, sessionId);
  const manifest = await readArtifactManifest(projectRoot, session.sessionId);
  if (!stepId) {
    return manifest.entries;
  }

  return manifest.entries.filter((entry) => entry.stepId === stepId);
}

export async function readArtifact(
  projectRoot: string,
  sessionId: string,
  relativePath: string,
): Promise<{
  contentType?: string;
  text?: string;
  base64?: string;
}> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  await readSession(projectRoot, sessionId);
  const manifest = await readArtifactManifest(projectRoot, sessionId);
  const manifestEntry = manifest.entries.find(
    (entry) => entry.relativePath === relativePath,
  );
  if (!manifestEntry) {
    throw new HttpiError(
      "ARTIFACT_NOT_FOUND",
      `Artifact ${relativePath} was not found for session ${sessionId}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const sessionArtifactRoot = resolveFromRoot(
    runtimePaths.responsesDir,
    sessionId,
  );
  const absolutePath = resolveFromRoot(sessionArtifactRoot, relativePath);
  assertPathWithin(sessionArtifactRoot, absolutePath, {
    code: "ARTIFACT_PATH_INVALID",
    message: `Artifact path ${relativePath} must stay within session ${sessionId}.`,
    exitCode: exitCodes.validationFailure,
  });
  const artifactStats = await lstat(absolutePath);
  if (artifactStats.isSymbolicLink()) {
    throw new HttpiError(
      "ARTIFACT_PATH_INVALID",
      `Artifact path ${relativePath} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const resolvedArtifactRoot = await realpath(sessionArtifactRoot);
  const resolvedArtifactPath = await realpath(absolutePath);
  assertPathWithin(resolvedArtifactRoot, resolvedArtifactPath, {
    code: "ARTIFACT_PATH_INVALID",
    message: `Artifact path ${relativePath} must stay within session ${sessionId}.`,
    exitCode: exitCodes.validationFailure,
  });
  const buffer = await readFile(resolvedArtifactPath);
  const extension = extname(relativePath).toLowerCase();
  const contentType = manifestEntry.contentType;

  if (isTextArtifact(extension, contentType)) {
    return {
      ...(contentType ? { contentType } : {}),
      text: buffer.toString("utf8"),
    };
  }

  return {
    ...(contentType ? { contentType } : {}),
    base64: buffer.toString("base64"),
  };
}

export async function loadSecrets(
  projectRoot: string,
): Promise<Record<string, string>> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  if (!(await fileExists(runtimePaths.secretsPath))) {
    return {};
  }

  const secretsStats = await lstat(runtimePaths.secretsPath);
  if (secretsStats.isSymbolicLink()) {
    throw new HttpiError(
      "SECRETS_PATH_INVALID",
      "The local .httpi/secrets.yaml file must not resolve through a symlink.",
      { exitCode: exitCodes.validationFailure },
    );
  }
  const resolvedRuntimeDir = await realpath(runtimePaths.runtimeDir);
  const resolvedSecretsPath = await realpath(runtimePaths.secretsPath);
  assertPathWithin(resolvedRuntimeDir, resolvedSecretsPath, {
    code: "SECRETS_PATH_INVALID",
    message: "The local .httpi/secrets.yaml file must stay within .httpi/.",
    exitCode: exitCodes.validationFailure,
  });
  if (process.platform !== "win32") {
    await chmod(runtimePaths.secretsPath, runtimeFileMode);
  }

  const rawContent = await readUtf8File(runtimePaths.secretsPath);
  const document = parseDocument(rawContent);
  if (document.errors.length > 0) {
    throw new HttpiError(
      "SECRETS_INVALID",
      "The local .httpi/secrets.yaml file could not be parsed.",
      {
        exitCode: exitCodes.validationFailure,
        details: document.errors.map((error) => error.message),
      },
    );
  }

  const parsedValue = document.toJS();
  const valuesRecord = isStringRecord(parsedValue)
    ? parsedValue
    : extractValuesRecord(parsedValue);

  if (!valuesRecord) {
    throw new HttpiError(
      "SECRETS_INVALID",
      "The local .httpi/secrets.yaml file must be a string map or contain a values string map.",
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }

  return valuesRecord;
}

export async function detectDefinitionDrift(
  session: SessionRecord,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  for (const [filePath, expectedHash] of Object.entries(
    session.compiled.definitionHashes,
  )) {
    if (!(await fileExists(filePath))) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_DELETED",
        message: `Tracked file ${filePath} no longer exists.`,
        filePath,
      });
      continue;
    }

    const currentHash = sha256Hex(await readUtf8File(filePath));
    if (currentHash !== expectedHash) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_DRIFT",
        message: `Tracked file ${filePath} changed after session creation.`,
        filePath,
      });
    }
  }

  return diagnostics;
}

export function touchSession(
  session: SessionRecord,
  state?: SessionRecord["state"],
): SessionRecord {
  return {
    ...session,
    state: state ?? session.state,
    updatedAt: toIsoTimestamp(),
  };
}

export function updateStepState(
  session: SessionRecord,
  stepId: string,
  state: StepState,
): SessionRecord {
  const currentStepRecord = session.stepRecords[stepId];
  if (!currentStepRecord) {
    throw new HttpiError(
      "STEP_NOT_FOUND",
      `Step ${stepId} is not present in session ${session.sessionId}.`,
      { exitCode: exitCodes.internalError },
    );
  }
  const nextStepRecord: SessionStepRecord = {
    ...currentStepRecord,
    state,
  };
  return {
    ...session,
    stepRecords: {
      ...session.stepRecords,
      [stepId]: nextStepRecord,
    },
    updatedAt: toIsoTimestamp(),
  };
}

export function redactArtifactText(
  value: string,
  secretValues: Iterable<string>,
): string {
  return redactText(value, secretValues);
}

async function ensureSessionArtifactRoot(
  projectRoot: string,
  session: SessionRecord,
): Promise<void> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, session.sessionId);
  await ensureDir(sessionPaths.artifactRoot, runtimeDirectoryMode);
  await chmod(sessionPaths.artifactRoot, runtimeDirectoryMode);
}

async function readArtifactManifest(
  projectRoot: string,
  sessionId: string,
): Promise<ArtifactManifest> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  if (!(await fileExists(sessionPaths.manifestPath))) {
    return {
      schemaVersion,
      sessionId,
      entries: [],
    };
  }

  const manifest = await readJsonFile<ArtifactManifest>(sessionPaths.manifestPath);
  if (
    manifest.schemaVersion !== schemaVersion ||
    manifest.sessionId !== sessionId ||
    !Array.isArray(manifest.entries)
  ) {
    throw new HttpiError(
      "ARTIFACT_MANIFEST_INVALID",
      `Artifact manifest for session ${sessionId} is invalid.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return manifest;
}

function sortArtifactManifestEntries(
  entries: ArtifactManifestEntry[],
): ArtifactManifestEntry[] {
  return [...entries].sort((left, right) => {
    const stepComparison = left.stepId.localeCompare(right.stepId);
    if (stepComparison !== 0) {
      return stepComparison;
    }

    const attemptComparison = left.attempt - right.attempt;
    if (attemptComparison !== 0) {
      return attemptComparison;
    }

    const kindComparison = left.kind.localeCompare(right.kind);
    if (kindComparison !== 0) {
      return kindComparison;
    }

    return left.relativePath.localeCompare(right.relativePath);
  });
}

function buildRelativeArtifactPath(
  stepId: string,
  attempt: number,
  fileName: string,
): string {
  return join(
    "steps",
    sanitizeFileSegment(stepId),
    `attempt-${attempt}`,
    fileName,
  );
}

function selectBodyFileName(contentType: string | undefined): string {
  if (contentType?.includes("json")) {
    return "body.json";
  }

  if (contentType?.startsWith("text/")) {
    return "body.txt";
  }

  return "body.bin";
}

function isTextArtifact(
  extension: string,
  contentType: string | undefined,
): boolean {
  return (
    contentType === "application/json" ||
    contentType?.startsWith("text/") === true ||
    extension === ".json" ||
    extension === ".txt" ||
    extension === ".jsonl"
  );
}

function extractValuesRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "values" in value &&
    isStringRecord(value.values)
  ) {
    return value.values;
  }

  return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function assertValidSessionId(sessionId: string): void {
  if (sessionIdPattern.test(sessionId)) {
    return;
  }

  throw new HttpiError(
    "SESSION_ID_INVALID",
    `Session ID ${sessionId} is invalid.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function assertValidSessionRecord(
  session: SessionRecord,
  sessionId: string,
): void {
  if (
    session.schemaVersion === schemaVersion &&
    session.sessionId === sessionId &&
    typeof session.runId === "string" &&
    typeof session.envId === "string" &&
    typeof session.state === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    typeof session.artifactManifestPath === "string" &&
    typeof session.eventLogPath === "string" &&
    typeof session.compiled === "object" &&
    session.compiled !== null &&
    typeof session.stepRecords === "object" &&
    session.stepRecords !== null &&
    typeof session.stepOutputs === "object" &&
    session.stepOutputs !== null
  ) {
    return;
  }

  throw new HttpiError(
    "SESSION_INVALID",
    `Session ${sessionId} is invalid or unreadable.`,
    { exitCode: exitCodes.validationFailure },
  );
} 

function getSessionRuntimePaths(runtimePaths: RuntimePaths, sessionId: string): {
  sessionPath: string;
  lockFilePath: string;
  artifactRoot: string;
  manifestPath: string;
  eventLogPath: string;
} {
  const artifactRoot = resolveFromRoot(runtimePaths.responsesDir, sessionId);
  return {
    sessionPath: resolveFromRoot(runtimePaths.sessionsDir, `${sessionId}.json`),
    lockFilePath: resolveFromRoot(runtimePaths.sessionsDir, `${sessionId}.lock`),
    artifactRoot,
    manifestPath: resolveFromRoot(artifactRoot, "manifest.json"),
    eventLogPath: resolveFromRoot(artifactRoot, "events.jsonl"),
  };
}

async function withSerializedFileOperation<TValue>(
  key: string,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const previous = serializedFileOperations.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const next = previous.catch(() => undefined).then(() => current);
  serializedFileOperations.set(key, next);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent?.();
    void next.finally(() => {
      if (serializedFileOperations.get(key) === next) {
        serializedFileOperations.delete(key);
      }
    });
  }
}

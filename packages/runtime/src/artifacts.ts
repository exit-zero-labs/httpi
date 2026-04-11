import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
  ArtifactManifest,
  ArtifactManifestEntry,
  SessionEvent,
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import {
  appendJsonLine,
  assertPathWithin,
  exitCodes,
  fileExists,
  HttpiError,
  readJsonFile,
  redactText,
  resolveFromRoot,
  sanitizeFileSegment,
  writeFileAtomic,
  writeJsonFileAtomic,
} from "@exit-zero-labs/httpi-shared";
import { withSerializedFileOperation } from "./file-operations.js";
import {
  assertProjectOwnedFileIfExists,
  assertValidSessionId,
  ensureProjectOwnedDirectory,
  ensureRuntimePaths,
  getSessionRuntimePaths,
  runtimeDirectoryMode,
  runtimeFileMode,
} from "./runtime-paths.js";
import { readSession } from "./sessions.js";

export interface StepArtifactWriteInput {
  stepId: string;
  attempt: number;
  requestSummary?: unknown;
  responseMetadata?: unknown;
  bodyText?: string | undefined;
  bodyBase64?: string | undefined;
  contentType?: string | undefined;
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
    await assertProjectOwnedFileIfExists(
      projectRoot,
      sessionPaths.eventLogPath,
      `The event log for session ${session.sessionId}`,
    );
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
    await ensureProjectOwnedDirectory(
      projectRoot,
      attemptDirectory,
      `The local .httpi/responses/${session.sessionId}/steps/${sanitizeFileSegment(
        input.stepId,
      )}/attempt-${input.attempt} directory`,
    );
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
      await ensureProjectOwnedDirectory(
        projectRoot,
        dirname(absolutePath),
        `The local directory for artifact ${relativePath}`,
      );

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
    await assertProjectOwnedFileIfExists(
      projectRoot,
      sessionPaths.manifestPath,
      `The artifact manifest for session ${session.sessionId}`,
    );
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
  await ensureProjectOwnedDirectory(
    projectRoot,
    sessionPaths.artifactRoot,
    `The local .httpi/responses/${session.sessionId} directory`,
  );
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

  await assertProjectOwnedFileIfExists(
    projectRoot,
    sessionPaths.manifestPath,
    `The artifact manifest for session ${sessionId}`,
  );
  const manifest = await readJsonFile<ArtifactManifest>(
    sessionPaths.manifestPath,
  );
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

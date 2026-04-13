/**
 * Runtime artifact persistence and inspection helpers.
 *
 * This module owns `httpi/artifacts/history/<sessionId>/`, including event logs,
 * manifests, step artifacts, and safe read-back of captured files.
 */
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
  ArtifactManifest,
  ArtifactManifestEntry,
  RequestArtifactRecord,
  SessionEvent,
  SessionRecord,
  StepArtifactSummary,
  StreamChunkRecord,
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

/** All artifact payloads that may be written for one step attempt. */
export interface StepArtifactWriteInput {
  stepId: string;
  attempt: number;
  request?: RequestArtifactRecord;
  bodyText?: string | undefined;
  bodyBase64?: string | undefined;
  contentType?: string | undefined;
  streamChunks?: StreamChunkRecord[] | undefined;
  streamAssembledText?: string | undefined;
  streamAssembledJson?: unknown | undefined;
  binary?:
    | {
        absolutePath: string;
        relativePath: string;
        bytes: number;
        sha256: string;
        truncated: boolean;
      }
    | undefined;
}

/** Append one structured lifecycle event to a session's `events.jsonl` log. */
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

/** Persist all artifacts captured for one step attempt and update the manifest. */
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
      `The local httpi/artifacts/history/${session.sessionId}/steps/${sanitizeFileSegment(
        input.stepId,
      )}/attempt-${input.attempt} directory`,
    );
    await chmod(attemptDirectory, runtimeDirectoryMode);

    const summary: StepArtifactSummary = {};
    const manifest = await readArtifactManifest(projectRoot, session.sessionId);

    if (input.request !== undefined) {
      const relativePath = buildRelativeArtifactPath(
        input.stepId,
        input.attempt,
        "request.json",
      );
      const absolutePath = resolveFromRoot(artifactRoot, relativePath);
      await writeJsonFileAtomic(
        absolutePath,
        input.request,
        runtimeFileMode,
      );
      summary.requestPath = relativePath;
      manifest.entries.push({
        schemaVersion,
        sessionId: session.sessionId,
        stepId: input.stepId,
        attempt: input.attempt,
        kind: "request",
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

    // Stream chunk artifacts (A1)
    const hasStreamChunks = input.streamChunks && input.streamChunks.length > 0;
    const hasStreamAssembled =
      input.streamAssembledJson !== undefined ||
      input.streamAssembledText !== undefined;
    if (hasStreamChunks || hasStreamAssembled) {
      const streamDir = resolveFromRoot(
        artifactRoot,
        "steps",
        sanitizeFileSegment(input.stepId),
        `attempt-${input.attempt}`,
        "stream",
      );
      await ensureProjectOwnedDirectory(
        projectRoot,
        streamDir,
        `The stream artifact directory for step ${input.stepId}`,
      );
      await chmod(streamDir, runtimeDirectoryMode);

      if (hasStreamChunks) {
        const chunksRelPath = buildRelativeArtifactPath(
          input.stepId,
          input.attempt,
          "stream/chunks.jsonl",
        );
        const chunksAbsPath = resolveFromRoot(artifactRoot, chunksRelPath);
        const chunksContent = (input.streamChunks ?? [])
          .map((c) => JSON.stringify(c))
          .join("\n");
        await writeFileAtomic(chunksAbsPath, `${chunksContent}\n`, {
          mode: runtimeFileMode,
        });
        summary.streamChunksPath = chunksRelPath;
        manifest.entries.push({
          schemaVersion,
          sessionId: session.sessionId,
          stepId: input.stepId,
          attempt: input.attempt,
          kind: "stream.chunks",
          relativePath: chunksRelPath,
          contentType: "application/x-ndjson",
        });
      }

      // Assembled stream body
      if (
        input.streamAssembledJson !== undefined ||
        input.streamAssembledText !== undefined
      ) {
        const isJson = input.streamAssembledJson !== undefined;
        const assembledFileName = isJson
          ? "stream/assembled.json"
          : "stream/assembled.txt";
        const assembledRelPath = buildRelativeArtifactPath(
          input.stepId,
          input.attempt,
          assembledFileName,
        );
        const assembledAbsPath = resolveFromRoot(
          artifactRoot,
          assembledRelPath,
        );

        if (isJson) {
          await writeJsonFileAtomic(
            assembledAbsPath,
            input.streamAssembledJson,
            runtimeFileMode,
          );
        } else {
          await writeFileAtomic(
            assembledAbsPath,
            input.streamAssembledText ?? "",
            { mode: runtimeFileMode },
          );
        }
        summary.streamAssembledPath = assembledRelPath;
        manifest.entries.push({
          schemaVersion,
          sessionId: session.sessionId,
          stepId: input.stepId,
          attempt: input.attempt,
          kind: "stream.assembled",
          relativePath: assembledRelPath,
          contentType: isJson ? "application/json" : "text/plain",
        });
      }
    }

    // Binary response (A3): record a manifest entry with sha256/size/path but
    // do not inline the body. Path is stored verbatim; it may live outside
    // httpi/artifacts/history when the user explicitly opts into a different saveTo.
    if (input.binary) {
      manifest.entries.push({
        schemaVersion,
        sessionId: session.sessionId,
        stepId: input.stepId,
        attempt: input.attempt,
        kind: "response.binary" as ArtifactManifestEntry["kind"],
        relativePath: input.binary.relativePath,
        contentType: "application/octet-stream",
        sha256: input.binary.sha256,
        sizeBytes: input.binary.bytes,
      } as ArtifactManifestEntry);
      summary.binaryPath = input.binary.relativePath;
      summary.binarySha256 = input.binary.sha256;
      summary.binaryBytes = input.binary.bytes;
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

/** List artifact manifest entries for a session, optionally filtered to one step. */
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

/** Read one captured artifact after validating ownership and manifest membership. */
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
    runtimePaths.historyDir,
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

/** Apply standard secret redaction to text that may be surfaced publicly. */
export function redactArtifactText(
  value: string,
  secretValues: Iterable<string>,
): string {
  return redactText(value, secretValues);
}

/** Half-open range used to slice a captured stream chunk sequence. */
export interface StreamChunkRange {
  start?: number | undefined;
  end?: number | undefined;
}

/** Read result for the latest captured stream chunk artifact of a step. */
export interface StreamChunksResult {
  sessionId: string;
  stepId: string;
  attempt: number;
  relativePath: string;
  totalChunks: number;
  chunks: StreamChunkRecord[];
  range?: { start: number; end: number } | undefined;
}

/** Read and optionally slice the latest `stream/chunks.jsonl` artifact for a step. */
export async function readStreamChunks(
  projectRoot: string,
  sessionId: string,
  stepId: string,
  range?: StreamChunkRange,
): Promise<StreamChunksResult> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  await readSession(projectRoot, sessionId);
  const manifest = await readArtifactManifest(projectRoot, sessionId);

  const matching = manifest.entries.filter(
    (entry) =>
      entry.stepId === stepId && (entry.kind as string) === "stream.chunks",
  );
  if (matching.length === 0) {
    throw new HttpiError(
      "STREAM_CHUNKS_NOT_FOUND",
      `No stream chunk artifacts were captured for step ${stepId} in session ${sessionId}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  // Pick the highest attempt
  const entry = matching.reduce((acc, cur) =>
    cur.attempt > acc.attempt ? cur : acc,
  );

  const sessionArtifactRoot = resolveFromRoot(
    runtimePaths.historyDir,
    sessionId,
  );
  const absolutePath = resolveFromRoot(sessionArtifactRoot, entry.relativePath);
  assertPathWithin(sessionArtifactRoot, absolutePath, {
    code: "ARTIFACT_PATH_INVALID",
    message: `Artifact path ${entry.relativePath} must stay within session ${sessionId}.`,
    exitCode: exitCodes.validationFailure,
  });
  const artifactStats = await lstat(absolutePath);
  if (artifactStats.isSymbolicLink()) {
    throw new HttpiError(
      "ARTIFACT_PATH_INVALID",
      `Artifact path ${entry.relativePath} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const resolvedArtifactRoot = await realpath(sessionArtifactRoot);
  const resolvedArtifactPath = await realpath(absolutePath);
  assertPathWithin(resolvedArtifactRoot, resolvedArtifactPath, {
    code: "ARTIFACT_PATH_INVALID",
    message: `Artifact path ${entry.relativePath} must stay within session ${sessionId}.`,
    exitCode: exitCodes.validationFailure,
  });
  const raw = (await readFile(resolvedArtifactPath, "utf8")).trimEnd();
  const lines = raw.length === 0 ? [] : raw.split("\n");
  const parsed: StreamChunkRecord[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      parsed.push(JSON.parse(line) as StreamChunkRecord);
    } catch {
      // skip malformed line rather than fail
    }
  }

  const total = parsed.length;
  const start = Math.max(0, range?.start ?? 0);
  const endRaw = range?.end ?? total;
  const end = Math.min(total, Math.max(start, endRaw));
  const sliced =
    start === 0 && end === total ? parsed : parsed.slice(start, end);

  return {
    sessionId,
    stepId,
    attempt: entry.attempt,
    relativePath: entry.relativePath,
    totalChunks: total,
    chunks: sliced,
    ...(range ? { range: { start, end } } : {}),
  };
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
    `The local httpi/artifacts/history/${session.sessionId} directory`,
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

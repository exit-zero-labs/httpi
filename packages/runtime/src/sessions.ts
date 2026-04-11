import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  SessionRecord,
  SessionStepRecord,
  StepState,
} from "@exit-zero-labs/httpi-contracts";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import {
  createSessionId,
  exitCodes,
  fileExists,
  HttpiError,
  readJsonFile,
  resolveFromRoot,
  runtimeDirectoryName,
  toIsoTimestamp,
  writeJsonFileAtomic,
} from "@exit-zero-labs/httpi-shared";
import {
  assertProjectOwnedFileIfExists,
  assertValidSessionId,
  ensureRuntimePaths,
  getSessionRuntimePaths,
  runtimeFileMode,
} from "./runtime-paths.js";

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
  await assertProjectOwnedFileIfExists(
    projectRoot,
    sessionPaths.sessionPath,
    `The session file for ${session.sessionId}`,
  );
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

  await assertProjectOwnedFileIfExists(
    projectRoot,
    sessionPaths.sessionPath,
    `The session file for ${sessionId}`,
  );
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
    sessionFiles.map(async (entry) => {
      const sessionPath = resolveFromRoot(runtimePaths.sessionsDir, entry.name);
      await assertProjectOwnedFileIfExists(
        projectRoot,
        sessionPath,
        `The session file ${entry.name}`,
      );
      return readJsonFile<SessionRecord>(sessionPath);
    }),
  );

  return sessions.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
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

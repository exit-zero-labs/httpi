import type {
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import {
  exitCodes,
  HttpiError,
  toIsoTimestamp,
} from "@exit-zero-labs/httpi-shared";
import { getSessionStepRecord } from "./project-context.js";

interface FinishAttemptOptions {
  outcome: "success" | "failed" | "paused";
  statusCode?: number;
  durationMs?: number;
  errorMessage?: string;
  artifacts?: StepArtifactSummary;
}

export function findStepStartIndex(session: SessionRecord): number {
  if (!session.nextStepId) {
    return 0;
  }

  const foundIndex = session.compiled.steps.findIndex(
    (step) => step.id === session.nextStepId,
  );
  if (foundIndex !== -1) {
    return foundIndex;
  }

  throw new HttpiError(
    "STEP_NOT_FOUND",
    `Session ${session.sessionId} points at missing step ${session.nextStepId}.`,
    { exitCode: exitCodes.unsafeResume },
  );
}

export function applyPause(
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

export function nextAttemptNumber(
  session: SessionRecord,
  stepId: string,
): number {
  return getSessionStepRecord(session, stepId).attempts.length + 1;
}

export function startAttempt(
  session: SessionRecord,
  stepId: string,
  kind: "request" | "parallel" | "pause" | "pollUntil",
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

export function finishAttempt(
  session: SessionRecord,
  stepId: string,
  state: "completed" | "failed" | "paused",
  attempt: number,
  options: FinishAttemptOptions,
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

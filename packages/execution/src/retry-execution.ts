import type {
  CompiledRequestStep,
  RetryPolicy,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  appendSessionEvent,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";
import { toIsoTimestamp } from "@exit-zero-labs/httpi-shared";
import { executeRequestStep } from "./request-step-execution.js";
import type { RequestExecutionOutcome } from "./types.js";

export async function executeRequestStepWithRetry(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
): Promise<RequestExecutionOutcome> {
  const retry = step.retry;
  if (!retry || retry.maxAttempts <= 1) {
    return executeRequestStep(projectRoot, session, step);
  }

  let currentSession = session;
  let lastOutcome: RequestExecutionOutcome | undefined;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    const outcome = await executeRequestStep(projectRoot, currentSession, step);

    if (outcome.success) {
      return outcome;
    }

    lastOutcome = outcome;
    currentSession = outcome.session;

    // Check if the failure is retryable
    if (!isRetryableFailure(currentSession, step.id, retry)) {
      return outcome;
    }

    // Don't retry after the last attempt
    if (attempt >= retry.maxAttempts) {
      await appendSessionEvent(projectRoot, currentSession, {
        schemaVersion: currentSession.schemaVersion,
        eventType: "retry.given-up",
        timestamp: toIsoTimestamp(),
        sessionId: currentSession.sessionId,
        runId: currentSession.runId,
        stepId: step.id,
        attempt,
        message: `Exhausted ${retry.maxAttempts} retry attempts.`,
      });
      return outcome;
    }

    // Calculate delay with backoff and jitter
    const delayMs = calculateRetryDelay(retry, attempt);

    await appendSessionEvent(projectRoot, currentSession, {
      schemaVersion: currentSession.schemaVersion,
      eventType: "retry.scheduled",
      timestamp: toIsoTimestamp(),
      sessionId: currentSession.sessionId,
      runId: currentSession.runId,
      stepId: step.id,
      attempt,
      durationMs: delayMs,
      message: `Retrying in ${delayMs}ms (attempt ${attempt + 1}/${retry.maxAttempts}).`,
    });

    // Reset step state back to running for the next attempt
    const existingRecord = currentSession.stepRecords[step.id];
    currentSession = {
      ...currentSession,
      state: "running",
      failureReason: undefined,
      stepRecords: {
        ...currentSession.stepRecords,
        ...(existingRecord
          ? { [step.id]: { ...existingRecord, state: "running" as const } }
          : {}),
      },
      updatedAt: toIsoTimestamp(),
    };
    await writeSession(projectRoot, currentSession);

    await sleep(delayMs);
  }

  return lastOutcome!;
}

function isRetryableFailure(
  session: SessionRecord,
  stepId: string,
  retry: RetryPolicy,
): boolean {
  const stepRecord = session.stepRecords[stepId];
  if (!stepRecord) return false;

  const lastAttempt = stepRecord.attempts[stepRecord.attempts.length - 1];
  if (!lastAttempt) return false;

  // Check status-based retry conditions
  if (retry.retryOn?.status && lastAttempt.statusCode !== undefined) {
    if (retry.retryOn.status.includes(lastAttempt.statusCode)) {
      return true;
    }
  }

  // Check error-class-based retry conditions
  if (retry.retryOn?.errorClass) {
    const errorMessage = lastAttempt.errorMessage ?? "";
    for (const errorClass of retry.retryOn.errorClass) {
      if (errorClass === "network" && errorMessage.includes("network")) {
        return true;
      }
      if (errorClass === "timeout" && errorMessage.includes("timed out")) {
        return true;
      }
    }
  }

  // If no retryOn conditions specified, retry on any failure
  if (!retry.retryOn?.status && !retry.retryOn?.errorClass) {
    return true;
  }

  return false;
}

function calculateRetryDelay(retry: RetryPolicy, attempt: number): number {
  const baseDelay = retry.initialDelayMs ?? 250;
  const backoff = retry.backoff ?? "exponential";
  const jitter = retry.jitter ?? "none";

  let delay: number;
  switch (backoff) {
    case "exponential":
      delay = baseDelay * 2 ** (attempt - 1);
      break;
    case "linear":
      delay = baseDelay * attempt;
      break;
    case "constant":
      delay = baseDelay;
      break;
    default:
      delay = baseDelay;
  }

  switch (jitter) {
    case "full":
      delay = Math.floor(Math.random() * delay);
      break;
    case "equal":
      delay = Math.floor(delay / 2 + Math.random() * (delay / 2));
      break;
    case "none":
      break;
  }

  const cap = retry.maxDelayMs ?? 30_000;
  return Math.max(0, Math.min(Math.round(delay), cap));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

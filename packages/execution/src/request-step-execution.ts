import type {
  CompiledRequestStep,
  HttpExecutionResult,
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import { executeHttpRequest } from "@exit-zero-labs/httpi-http";
import {
  appendSessionEvent,
  redactArtifactText,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";
import {
  coerceErrorMessage,
  toIsoTimestamp,
} from "@exit-zero-labs/httpi-shared";
import { getSessionStepRecord } from "./project-context.js";
import {
  assertStatusExpectation,
  maybeWriteRequestArtifacts,
} from "./request-artifacts.js";
import { extractStepOutputs } from "./request-outputs.js";
import { materializeRequest } from "./request-resolution.js";
import {
  collectSecretOutputValues,
  collectSecretStepOutputs,
  uniqueSecretValues,
} from "./request-secrets.js";
import {
  finishAttempt,
  nextAttemptNumber,
  startAttempt,
} from "./session-attempts.js";
import type {
  ExtractedStepOutputs,
  RequestExecutionOutcome,
  RequestMaterializationResult,
} from "./types.js";

export async function executeRequestStep(
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

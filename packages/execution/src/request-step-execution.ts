/**
 * Execution of one compiled request step.
 *
 * The request-step executor is the narrow waist between request materialization,
 * HTTP transport, assertion evaluation, extraction, and artifact persistence.
 */
import type {
  AssertionResult,
  CompiledRequestStep,
  EnrichedDiagnostic,
  HttpExecutionResult,
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import { isDiagnostic } from "@exit-zero-labs/httpi-contracts";
import {
  enrichDiagnosticsFromFiles,
  finalizeDiagnostic,
} from "@exit-zero-labs/httpi-definitions";
import { executeHttpRequest } from "@exit-zero-labs/httpi-http";
import {
  appendSessionEvent,
  isSessionCancelled,
  redactArtifactText,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";
import {
  coerceErrorMessage,
  exitCodes,
  HttpiError,
  isHttpiError,
  redactJsonValue,
  toIsoTimestamp,
} from "@exit-zero-labs/httpi-shared";
import { evaluateAssertions, evaluateSchemaAssertions } from "./assertions.js";
import { getSessionStepRecord } from "./project-context.js";
import { maybeWriteRequestArtifacts } from "./request-artifacts.js";
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

/**
 * Execute one request step attempt and merge the result back into session state.
 *
 * When `persistState` is false, callers are responsible for the surrounding
 * session write strategy (for example inside parallel orchestration).
 */
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
      {
        shouldCancel: () =>
          isSessionCancelled(projectRoot, nextSession.sessionId),
        stream: {
          onFirstByte: ({ tOffsetMs }) => {
            void appendSessionEvent(projectRoot, nextSession, {
              schemaVersion: nextSession.schemaVersion,
              eventType: "stream.first-byte",
              timestamp: toIsoTimestamp(),
              sessionId: nextSession.sessionId,
              runId: nextSession.runId,
              stepId: step.id,
              attempt,
              outcome: "running",
              message: `tOffsetMs=${tOffsetMs}`,
            });
          },
          onChunk: (record) => {
            void appendSessionEvent(projectRoot, nextSession, {
              schemaVersion: nextSession.schemaVersion,
              eventType: "stream.chunk.received",
              timestamp: toIsoTimestamp(),
              sessionId: nextSession.sessionId,
              runId: nextSession.runId,
              stepId: step.id,
              attempt,
              outcome: "running",
              message: `seq=${record.seq} bytes=${record.bytes}`,
            });
          },
          onCompleted: ({ totalChunks, totalBytes, durationMs }) => {
            void appendSessionEvent(projectRoot, nextSession, {
              schemaVersion: nextSession.schemaVersion,
              eventType: "stream.completed",
              timestamp: toIsoTimestamp(),
              sessionId: nextSession.sessionId,
              runId: nextSession.runId,
              stepId: step.id,
              attempt,
              outcome: "success",
              message: `chunks=${totalChunks} bytes=${totalBytes} durationMs=${durationMs}`,
            });
          },
          onFailed: ({ errorClass, message }) => {
            void appendSessionEvent(projectRoot, nextSession, {
              schemaVersion: nextSession.schemaVersion,
              eventType: "stream.failed",
              timestamp: toIsoTimestamp(),
              sessionId: nextSession.sessionId,
              runId: nextSession.runId,
              stepId: step.id,
              attempt,
              outcome: "failed",
              message: `${errorClass}: ${message}`,
            });
          },
        },
      },
    );
    // Redact secret values out of stream fields that feed assertion diagnostics
    // (assembledLast, assembledJson, assembledText, chunk previews) so a
    // schema-assertion failure's `actual` payload cannot leak secrets into
    // error output. Artifact-write layer redacts again when persisting.
    if (exchange.stream && secretValues.length > 0) {
      exchange = {
        ...exchange,
        stream: {
          ...exchange.stream,
          chunks: exchange.stream.chunks.map((c) => ({
            ...c,
            preview: redactArtifactText(c.preview, secretValues),
          })),
          ...(exchange.stream.assembledText !== undefined
            ? {
                assembledText: redactArtifactText(
                  exchange.stream.assembledText,
                  secretValues,
                ),
              }
            : {}),
          ...(exchange.stream.assembledJson !== undefined
            ? {
                assembledJson: redactJsonValue(
                  exchange.stream.assembledJson,
                  secretValues,
                ),
              }
            : {}),
          ...(exchange.stream.assembledLast !== undefined
            ? {
                assembledLast: redactJsonValue(
                  exchange.stream.assembledLast,
                  secretValues,
                ),
              }
            : {}),
        },
      };
    }
    await assertExpectations(projectRoot, step, exchange);
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
      diagnostics: [],
    };
  } catch (error) {
    const message = coerceErrorMessage(error);
    const diagnostics = redactExecutionDiagnostics(
      await resolveExecutionDiagnostics(error),
      secretValues,
    );

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
      diagnostics,
    };
  }
}

async function resolveExecutionDiagnostics(
  error: unknown,
): Promise<EnrichedDiagnostic[]> {
  if (!isHttpiError(error) || !Array.isArray(error.details)) {
    return [];
  }

  const diagnostics = error.details.filter(isDiagnostic);
  if (diagnostics.length === 0) {
    return [];
  }

  try {
    return await enrichDiagnosticsFromFiles(diagnostics);
  } catch {
    return diagnostics.map((diagnostic) => finalizeDiagnostic(diagnostic));
  }
}

function redactExecutionDiagnostics(
  diagnostics: EnrichedDiagnostic[],
  secretValues: string[],
): EnrichedDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: redactArtifactText(diagnostic.message, secretValues),
    hint: redactArtifactText(diagnostic.hint, secretValues),
  }));
}

async function assertExpectations(
  projectRoot: string,
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): Promise<void> {
  const expect = step.request.expect;
  if (
    !expect.status &&
    !expect.latencyMs &&
    !expect.headers &&
    !expect.body &&
    !expect.stream
  ) {
    return;
  }

  const results: AssertionResult[] = evaluateAssertions(expect, exchange);
  const schemaResults = await evaluateSchemaAssertions(expect, exchange, {
    projectRoot,
    requestFilePath: step.request.filePath,
  });
  results.push(...schemaResults);
  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) {
    return;
  }

  const first = failures[0]!;
  const message =
    failures.length === 1
      ? `Assertion failed: ${first.path} ${first.matcher} expected ${JSON.stringify(first.expected)} but got ${JSON.stringify(first.actual)}.`
      : `${failures.length} assertions failed. First: ${first.path} ${first.matcher} expected ${JSON.stringify(first.expected)} but got ${JSON.stringify(first.actual)}.`;

  throw new HttpiError("EXPECTATION_FAILED", message, {
    exitCode: exitCodes.executionFailure,
    details: failures.map((f) => ({
      level: "error" as const,
      code: "EXPECTATION_FAILED",
      message: `${f.path} ${f.matcher}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`,
      hint: "Update the expect block if the contract changed, or investigate why the response no longer matches.",
      filePath: step.request.filePath,
      path: `expect.${f.path}`,
    })),
  });
}

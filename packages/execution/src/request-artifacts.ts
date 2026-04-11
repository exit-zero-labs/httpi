import { Buffer } from "node:buffer";
import type {
  CompiledRequestStep,
  HttpExecutionResult,
  ResolvedRequestModel,
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import {
  redactArtifactText,
  writeStepArtifacts,
} from "@exit-zero-labs/httpi-runtime";
import {
  exitCodes,
  HttpiError,
  redactHeaders,
} from "@exit-zero-labs/httpi-shared";

export async function maybeWriteRequestArtifacts(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
  attempt: number,
  request: ResolvedRequestModel,
  exchange: HttpExecutionResult,
  secretValues: string[],
): Promise<StepArtifactSummary | undefined> {
  const capture = session.compiled.capture;
  if (
    !capture.requestSummary &&
    !capture.responseMetadata &&
    capture.responseBody === "none"
  ) {
    return undefined;
  }

  const requestSummary = capture.requestSummary
    ? {
        requestId: step.requestId,
        stepId: step.id,
        method: request.method,
        url: redactArtifactText(request.url, secretValues),
        headers: redactHeaders(
          request.headers,
          capture.redactHeaders,
          secretValues,
        ),
        bodyBytes:
          request.body?.binary?.byteLength ??
          (request.body?.text ? Buffer.byteLength(request.body.text) : 0),
        timeoutMs: request.timeoutMs,
      }
    : undefined;

  const responseMetadata = capture.responseMetadata
    ? {
        status: exchange.response.status,
        statusText: exchange.response.statusText,
        headers: redactHeaders(
          exchange.response.headers,
          capture.redactHeaders,
          secretValues,
        ),
        bodyBytes: exchange.response.bodyBytes,
        truncated: exchange.response.truncated,
        durationMs: exchange.durationMs,
      }
    : undefined;

  let bodyText: string | undefined;
  let bodyBase64: string | undefined;
  if (capture.responseBody === "full") {
    if (exchange.response.bodyText !== undefined) {
      bodyText = redactArtifactText(exchange.response.bodyText, secretValues);
    } else {
      bodyBase64 = exchange.response.bodyBase64;
    }
  }

  return writeStepArtifacts(projectRoot, session, {
    stepId: step.id,
    attempt,
    requestSummary,
    responseMetadata,
    bodyText,
    bodyBase64,
    contentType: exchange.response.contentType,
  });
}

export function assertStatusExpectation(
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): void {
  const expectedStatus = step.request.expect.status;
  if (expectedStatus === undefined) {
    return;
  }

  if (typeof expectedStatus === "number") {
    if (exchange.response.status !== expectedStatus) {
      throw new HttpiError(
        "EXPECTATION_FAILED",
        `Expected status ${expectedStatus} but received ${exchange.response.status}.`,
        { exitCode: exitCodes.executionFailure },
      );
    }
    return;
  }

  if (!expectedStatus.includes(exchange.response.status)) {
    throw new HttpiError(
      "EXPECTATION_FAILED",
      `Expected one of ${expectedStatus.join(", ")} but received ${exchange.response.status}.`,
      { exitCode: exitCodes.executionFailure },
    );
  }
}

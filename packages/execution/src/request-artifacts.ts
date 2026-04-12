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
import { redactHeaders } from "@exit-zero-labs/httpi-shared";

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

  // Stream artifacts — redact chunk previews before writing
  let streamChunks = exchange.stream?.chunks;
  let streamAssembledText = exchange.stream?.assembledText;
  const streamAssembledJson = exchange.stream?.assembledJson;
  if (streamChunks && secretValues.length > 0) {
    streamChunks = streamChunks.map((c) => ({
      ...c,
      preview: redactArtifactText(c.preview, secretValues),
    }));
  }
  if (streamAssembledText && secretValues.length > 0) {
    streamAssembledText = redactArtifactText(streamAssembledText, secretValues);
  }

  return writeStepArtifacts(projectRoot, session, {
    stepId: step.id,
    attempt,
    requestSummary,
    responseMetadata,
    bodyText,
    bodyBase64,
    contentType: exchange.response.contentType,
    streamChunks,
    streamAssembledText,
    streamAssembledJson,
  });
}

import { Buffer } from "node:buffer";
import type {
  CompiledRequestStep,
  HttpExecutionCapture,
  RequestArtifactError,
  RequestArtifactRecord,
  ResolvedRequestModel,
  SessionRecord,
  StepArtifactSummary,
} from "@exit-zero-labs/httpi-contracts";
import {
  redactArtifactText,
  writeStepArtifacts,
} from "@exit-zero-labs/httpi-runtime";
import { redactHeaders, redactJsonValue } from "@exit-zero-labs/httpi-shared";

interface RequestArtifactWriteResult {
  outcome: "success" | "failed";
  execution?: HttpExecutionCapture | undefined;
  error?: RequestArtifactError | undefined;
}

export async function maybeWriteRequestArtifacts(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
  attempt: number,
  request: ResolvedRequestModel,
  result: RequestArtifactWriteResult,
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

  const requestBodyBytes =
    request.body?.binary?.byteLength ??
    (request.body?.text ? Buffer.byteLength(request.body.text) : 0);
  const requestBody = buildRequestArtifactBody(request, secretValues);
  const response = result.execution?.response;

  let responseBodyText: string | undefined;
  let responseBodyBase64: string | undefined;
  if (capture.responseBody === "full" && response) {
    if (response.bodyText !== undefined) {
      responseBodyText = redactArtifactText(response.bodyText, secretValues);
    } else {
      responseBodyBase64 = response.bodyBase64;
    }
  }

  // Stream artifacts — redact chunk previews and the assembled JSON before
  // writing. Previously assembledJson bypassed redaction; a secret embedded
  // inside a streamed JSON field would leak into assembled.json on disk.
  let streamChunks = result.execution?.stream?.chunks;
  let streamAssembledText = result.execution?.stream?.assembledText;
  let streamAssembledJson = result.execution?.stream?.assembledJson;
  let streamAssembledLast = result.execution?.stream?.assembledLast;
  if (streamChunks && secretValues.length > 0) {
    streamChunks = streamChunks.map((chunk) => ({
      ...chunk,
      preview: redactArtifactText(chunk.preview, secretValues),
    }));
  }
  if (streamAssembledText && secretValues.length > 0) {
    streamAssembledText = redactArtifactText(
      streamAssembledText,
      secretValues,
    );
  }
  if (streamAssembledJson !== undefined && secretValues.length > 0) {
    streamAssembledJson = redactJsonValue(streamAssembledJson, secretValues);
  }
  if (streamAssembledLast !== undefined && secretValues.length > 0) {
    streamAssembledLast = redactJsonValue(streamAssembledLast, secretValues);
  }

  const requestArtifact: RequestArtifactRecord = {
    schemaVersion: session.schemaVersion,
    sessionId: session.sessionId,
    stepId: step.id,
    attempt,
    requestId: step.requestId,
    outcome: result.outcome,
    ...(result.execution?.durationMs !== undefined
      ? { durationMs: result.execution.durationMs }
      : {}),
    request: {
      method: request.method,
      url: redactArtifactText(request.url, secretValues),
      headers: redactHeaders(
        request.headers,
        capture.redactHeaders,
        secretValues,
      ),
      bodyBytes: requestBodyBytes,
      timeoutMs: request.timeoutMs,
      ...(request.responseMode ? { responseMode: request.responseMode } : {}),
      ...(request.responseMaxBytes !== undefined
        ? { responseMaxBytes: request.responseMaxBytes }
        : {}),
      ...(request.saveTo ? { saveTo: request.saveTo } : {}),
      ...(request.streamConfig ? { streamConfig: request.streamConfig } : {}),
      ...(requestBody ? { body: requestBody } : {}),
    },
    response: {
      received: response !== undefined,
      ...(response
        ? {
            status: response.status,
            statusText: response.statusText,
            headers: redactHeaders(
              response.headers,
              capture.redactHeaders,
              secretValues,
            ),
            bodyBytes: response.bodyBytes,
            contentType: response.contentType,
            truncated: response.truncated,
            ...(responseBodyText !== undefined
              ? { bodyText: responseBodyText }
              : {}),
            ...(responseBodyBase64 !== undefined
              ? { bodyBase64: responseBodyBase64 }
              : {}),
          }
        : {}),
    },
    ...(result.error
      ? {
          error: {
            ...result.error,
            message: redactArtifactText(result.error.message, secretValues),
          },
        }
      : {}),
    ...(result.execution?.stream
      ? {
          stream: {
            ...result.execution.stream,
            chunks: streamChunks ?? result.execution.stream.chunks,
            ...(streamAssembledText !== undefined
              ? { assembledText: streamAssembledText }
              : {}),
            ...(streamAssembledJson !== undefined
              ? { assembledJson: streamAssembledJson }
              : {}),
            ...(streamAssembledLast !== undefined
              ? { assembledLast: streamAssembledLast }
              : {}),
          },
        }
      : {}),
    ...(result.execution?.binary ? { binary: result.execution.binary } : {}),
  };

  return writeStepArtifacts(projectRoot, session, {
    stepId: step.id,
    attempt,
    request: requestArtifact,
    bodyText: responseBodyText,
    bodyBase64: responseBodyBase64,
    contentType: response?.contentType,
    streamChunks,
    streamAssembledText,
    streamAssembledJson,
    ...(result.execution?.binary ? { binary: result.execution.binary } : {}),
  });
}

function buildRequestArtifactBody(
  request: ResolvedRequestModel,
  secretValues: string[],
): RequestArtifactRecord["request"]["body"] {
  if (!request.body) {
    return undefined;
  }

  if (request.body.text !== undefined) {
    return {
      bytes: Buffer.byteLength(request.body.text),
      ...(request.body.contentType
        ? { contentType: request.body.contentType }
        : {}),
      text: redactArtifactText(request.body.text, secretValues),
    };
  }

  if (request.body.binary) {
    return {
      bytes: request.body.binary.byteLength,
      ...(request.body.contentType
        ? { contentType: request.body.contentType }
        : {}),
      base64: Buffer.from(request.body.binary).toString("base64"),
    };
  }

  return undefined;
}

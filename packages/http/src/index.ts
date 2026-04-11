import type {
  CapturePolicy,
  HttpExecutionResult,
  ResolvedRequestModel,
} from "@exit-zero-labs/httpi-contracts";
import { HttpiError, coerceErrorMessage, exitCodes } from "@exit-zero-labs/httpi-shared";

export async function executeHttpRequest(
  request: ResolvedRequestModel,
  capture: CapturePolicy,
): Promise<HttpExecutionResult> {
  const startedAt = performance.now();

  let requestBody: string | Uint8Array | undefined;
  if (request.body?.binary) {
    requestBody = request.body.binary;
  } else if (request.body?.text !== undefined) {
    requestBody = request.body.text;
  }

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.timeout(request.timeoutMs),
    };
    if (requestBody !== undefined) {
      requestInit.body = requestBody;
    }

    response = await fetch(request.url, requestInit);
  } catch (error) {
    throw new HttpiError(
      "HTTP_REQUEST_FAILED",
      `HTTP request failed: ${coerceErrorMessage(error)}`,
      {
        cause: error,
        exitCode: exitCodes.executionFailure,
      },
    );
  }

  const responseBuffer = Buffer.from(await response.arrayBuffer());
  const truncatedBuffer = responseBuffer.subarray(0, capture.maxBodyBytes);
  const contentType = response.headers.get("content-type") ?? undefined;
  const durationMs = Math.round(performance.now() - startedAt);
  const isTextResponse = shouldTreatAsText(contentType);

  return {
    request: {
      method: request.method,
      url: request.url,
      headers: request.headers,
      bodyBytes:
        request.body?.binary?.byteLength ??
        (request.body?.text ? Buffer.byteLength(request.body.text) : 0),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      bodyText: isTextResponse ? truncatedBuffer.toString("utf8") : undefined,
      bodyBase64: isTextResponse ? undefined : truncatedBuffer.toString("base64"),
      bodyBytes: responseBuffer.byteLength,
      contentType,
      truncated: responseBuffer.byteLength > truncatedBuffer.byteLength,
    },
    durationMs,
  };
}

function shouldTreatAsText(contentType: string | undefined): boolean {
  if (!contentType) {
    return true;
  }

  return (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

import type {
  CapturePolicy,
  HttpExecutionResult,
  ResolvedRequestModel,
  StreamChunkRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  coerceErrorMessage,
  exitCodes,
  HttpiError,
} from "@exit-zero-labs/httpi-shared";

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
    const message = coerceErrorMessage(error);
    const errorClass =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "timeout"
        : "network";
    throw new HttpiError(
      "HTTP_REQUEST_FAILED",
      `HTTP request failed: ${message}`,
      {
        cause: error,
        exitCode: exitCodes.executionFailure,
        details: [
          {
            level: "error" as const,
            code: "HTTP_REQUEST_FAILED",
            message: `HTTP request failed: ${message}`,
            hint:
              errorClass === "timeout"
                ? `Request timed out after ${request.timeoutMs}ms. Increase timeoutMs or check the server.`
                : "Check network connectivity and the target URL.",
          },
        ],
      },
    );
  }

  // Stream mode: parse chunks from the response body
  if (request.responseMode === "stream" && request.streamConfig) {
    return executeStreamingResponse(request, response, startedAt, capture);
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
      bodyBase64: isTextResponse
        ? undefined
        : truncatedBuffer.toString("base64"),
      bodyBytes: responseBuffer.byteLength,
      contentType,
      truncated: responseBuffer.byteLength > truncatedBuffer.byteLength,
    },
    durationMs,
  };
}

async function executeStreamingResponse(
  request: ResolvedRequestModel,
  response: Response,
  startedAt: number,
  capture: CapturePolicy,
): Promise<HttpExecutionResult> {
  const streamConfig = request.streamConfig!;
  const chunks: StreamChunkRecord[] = [];
  const assembledParts: string[] = [];
  let totalBytes = 0;
  let firstChunkMs: number | undefined;
  let lastChunkTime = performance.now();
  let maxInterChunkMs = 0;
  let seq = 0;
  let eventCount = 0;
  const maxBytes = streamConfig.maxBytes ?? capture.maxBodyBytes;

  const body = response.body;
  if (!body) {
    throw new HttpiError("STREAM_NO_BODY", "Response has no body to stream.", {
      exitCode: exitCodes.executionFailure,
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;
  const shouldCaptureChunks =
    !streamConfig.capture ||
    streamConfig.capture === "chunks" ||
    streamConfig.capture === "both";
  const shouldCaptureAssembled =
    !streamConfig.capture ||
    streamConfig.capture === "final" ||
    streamConfig.capture === "both";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }

      const now = performance.now();

      // Enforce maxBytes before appending to buffer
      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - totalBytes;
        const partial = value.subarray(0, remaining);
        // Use a fresh decoder to avoid corrupting state from prior stream: true calls
        buffer += new TextDecoder().decode(partial);
        totalBytes = maxBytes;
        break;
      }

      const text = decoder.decode(value, { stream: true });
      buffer += text;
      totalBytes += value.byteLength;

      if (firstChunkMs === undefined) {
        firstChunkMs = Math.round(now - startedAt);
      } else {
        const interChunk = Math.round(now - lastChunkTime);
        if (interChunk > maxInterChunkMs) {
          maxInterChunkMs = interChunk;
        }
      }
      lastChunkTime = now;

      // Parse complete events/lines from the buffer
      const parsed = parseStreamBuffer(buffer, streamConfig.parse);
      buffer = parsed.remaining;

      for (const event of parsed.events) {
        const tOffsetMs = Math.round(now - startedAt);
        const eventBytes = Buffer.byteLength(event);
        const preview =
          event.length > 200 ? `${event.slice(0, 200)}...` : event;

        if (shouldCaptureChunks) {
          chunks.push({
            seq,
            tOffsetMs,
            bytes: eventBytes,
            preview,
          });
        }
        if (shouldCaptureAssembled) {
          assembledParts.push(event);
        }
        seq++;
        eventCount++;
      }
    }
  } finally {
    // Cancel the underlying stream to close the socket immediately
    // when we broke early (maxBytes, error, etc.)
    if (!streamDone) {
      try {
        await reader.cancel();
      } catch {
        // stream may already be closed
      }
    }
    reader.releaseLock();
  }

  // For chunked-json: the entire buffer is the assembled output (flush remaining)
  if (streamConfig.parse === "chunked-json" && buffer.trim().length > 0) {
    if (shouldCaptureChunks) {
      chunks.push({
        seq,
        tOffsetMs: Math.round(performance.now() - startedAt),
        bytes: Buffer.byteLength(buffer),
        preview: buffer.length > 200 ? `${buffer.slice(0, 200)}...` : buffer,
      });
    }
    if (shouldCaptureAssembled) {
      assembledParts.push(buffer);
    }
    eventCount++;
  }

  const assembledText = shouldCaptureAssembled
    ? assembledParts.join("\n")
    : undefined;
  let assembledJson;
  if (shouldCaptureAssembled && assembledParts.length > 0) {
    try {
      if (streamConfig.parse === "ndjson") {
        assembledJson = assembledParts
          .filter((p) => p.trim().length > 0)
          .map((p) => {
            try {
              return JSON.parse(p);
            } catch {
              return p;
            }
          });
      } else if (streamConfig.parse === "chunked-json") {
        assembledJson = JSON.parse(assembledText!);
      } else {
        // SSE: try to parse data fields as JSON array
        assembledJson = assembledParts
          .filter((p) => p.trim().length > 0)
          .map((p) => {
            try {
              return JSON.parse(p);
            } catch {
              return p;
            }
          });
      }
    } catch {
      // assembled stays as text if JSON parsing fails
    }
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const durationMs = Math.round(performance.now() - startedAt);

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
      bodyText: assembledText,
      bodyBytes: totalBytes,
      contentType,
      truncated: totalBytes >= maxBytes,
    },
    stream: {
      chunks,
      assembledText,
      assembledJson,
      firstChunkMs,
      maxInterChunkMs,
      totalChunks: eventCount,
      totalBytes,
    },
    durationMs,
  };
}

interface ParseResult {
  events: string[];
  remaining: string;
}

function parseStreamBuffer(
  buffer: string,
  mode: "sse" | "ndjson" | "chunked-json",
): ParseResult {
  if (mode === "sse") {
    return parseSseBuffer(buffer);
  }
  if (mode === "ndjson") {
    return parseNdjsonBuffer(buffer);
  }
  // chunked-json: accumulate everything, no per-line parsing
  return { events: [], remaining: buffer };
}

function parseSseBuffer(buffer: string): ParseResult {
  const events: string[] = [];
  // Normalize CRLF to LF for consistent parsing (RFC 8895 allows \r\n, \r, or \n)
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // SSE events are separated by double newlines
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5));
      }
    }
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      // Skip [DONE] markers
      if (data.trim() !== "[DONE]") {
        events.push(data);
      }
    }
  }

  return { events, remaining };
}

function parseNdjsonBuffer(buffer: string): ParseResult {
  const events: string[] = [];
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      events.push(trimmed);
    }
  }

  return { events, remaining };
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

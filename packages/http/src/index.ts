/**
 * HTTP transport execution for resolved requests.
 *
 * The execution package hands this module a fully materialized request plus
 * capture policy. This module owns fetch invocation, buffered/streaming/binary
 * response handling, and normalization into `HttpExecutionResult`.
 */
import type {
  CapturePolicy,
  HttpExecutionHooks,
  HttpExecutionResult,
  JsonValue,
  ResolvedRequestModel,
  StreamChunkRecord,
} from "@exit-zero-labs/httpi-contracts";

type StreamAssembledLast = JsonValue;

import {
  coerceErrorMessage,
  exitCodes,
  HttpiError,
} from "@exit-zero-labs/httpi-shared";

/**
 * Execute one resolved HTTP request and normalize the response for the engine.
 *
 * `request.responseMode` selects buffered, streaming, or binary handling, while
 * `hooks` provide cooperative cancellation and stream lifecycle callbacks.
 */
export async function executeHttpRequest(
  request: ResolvedRequestModel,
  capture: CapturePolicy,
  hooks: HttpExecutionHooks = {},
): Promise<HttpExecutionResult> {
  const startedAt = performance.now();

  let requestBody: string | Uint8Array | undefined;
  if (request.body?.binary) {
    requestBody = request.body.binary;
  } else if (request.body?.text !== undefined) {
    requestBody = request.body.text;
  }

  // Combine timeout + external cancel into a single signal so mid-flight
  // fetches honor `httpi cancel` and SIGINT even before the read loop starts.
  const abortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
  const onTimeout = (): void => abortController.abort(timeoutSignal.reason);
  if (timeoutSignal.aborted) {
    abortController.abort(timeoutSignal.reason);
  } else {
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  }

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: abortController.signal,
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
    return executeStreamingResponse(
      request,
      response,
      startedAt,
      capture,
      hooks,
      abortController,
    );
  }

  // Binary mode (A3): stream to disk without buffering the whole body.
  if (request.responseMode === "binary") {
    return executeBinaryResponse(
      request,
      response,
      startedAt,
      capture,
      hooks,
      abortController,
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

/** Streaming response path for SSE, NDJSON, and chunked JSON request modes. */
async function executeStreamingResponse(
  request: ResolvedRequestModel,
  response: Response,
  startedAt: number,
  capture: CapturePolicy,
  hooks: HttpExecutionHooks,
  abortController: AbortController,
): Promise<HttpExecutionResult> {
  const streamConfig = request.streamConfig!;
  const streamHooks = hooks.stream ?? {};
  const shouldCancel = hooks.shouldCancel;
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

  let cancelled = false;
  // Race the read against a periodic cancel poll so a server that holds the
  // connection open but stops emitting chunks still honors `httpi cancel` and
  // SIGINT within ~100 ms (A2 SRE fix). Without this the cancel marker would
  // only be observed after the next chunk arrives, which may be never.
  const readWithCancelPoll = async (): Promise<
    | { kind: "read"; done: boolean; value: Uint8Array | undefined }
    | { kind: "cancel" }
  > => {
    const readPromise = reader
      .read()
      .then((r) => ({ kind: "read", done: r.done, value: r.value }) as const);
    if (!shouldCancel) return readPromise;
    let pollHandle: NodeJS.Timeout | undefined;
    const cancelPromise = new Promise<{ kind: "cancel" }>((resolve) => {
      const tick = async (): Promise<void> => {
        try {
          if (await shouldCancel()) {
            resolve({ kind: "cancel" });
            return;
          }
        } catch {
          // non-fatal
        }
        pollHandle = setTimeout(tick, 100);
      };
      pollHandle = setTimeout(tick, 100);
    });
    try {
      return await Promise.race([readPromise, cancelPromise]);
    } finally {
      if (pollHandle) clearTimeout(pollHandle);
    }
  };
  try {
    while (true) {
      const outcome = await readWithCancelPoll();
      if (outcome.kind === "cancel") {
        cancelled = true;
        abortController.abort();
        break;
      }
      const { done, value } = outcome;
      if (done) {
        streamDone = true;
        break;
      }
      if (!value) continue;

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
        try {
          streamHooks.onFirstByte?.({ tOffsetMs: firstChunkMs });
        } catch {
          // hook errors are non-fatal
        }
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

        const record: StreamChunkRecord = {
          seq,
          tOffsetMs,
          bytes: eventBytes,
          preview,
        };
        if (shouldCaptureChunks) {
          chunks.push(record);
        }
        if (shouldCaptureAssembled) {
          assembledParts.push(event);
        }
        try {
          streamHooks.onChunk?.(record);
        } catch {
          // hook errors are non-fatal
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
  let assembledJson: unknown;
  let assembledLast: unknown;
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
    // Derive the terminal frame for AI `finalAssembled` schema assertions.
    if (Array.isArray(assembledJson) && assembledJson.length > 0) {
      assembledLast = assembledJson[assembledJson.length - 1];
    } else if (assembledJson !== undefined) {
      assembledLast = assembledJson;
    }
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const durationMs = Math.round(performance.now() - startedAt);

  if (cancelled) {
    try {
      streamHooks.onFailed?.({
        errorClass: "cancelled",
        message: "stream cancelled via external signal",
      });
    } catch {
      // hook errors are non-fatal
    }
    throw new HttpiError(
      "HTTP_STREAM_CANCELLED",
      "Stream was cancelled before completion.",
      {
        exitCode: exitCodes.executionFailure,
        details: [
          {
            level: "error" as const,
            code: "HTTP_STREAM_CANCELLED",
            message: `Stream cancelled after ${eventCount} chunk(s).`,
            hint: "Cancellation was requested by the user (CLI, MCP, or SIGINT). Partial chunks were preserved.",
          },
        ],
      },
    );
  }

  try {
    streamHooks.onCompleted?.({
      totalChunks: eventCount,
      totalBytes,
      durationMs,
    });
  } catch {
    // hook errors are non-fatal
  }

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
      assembledJson: assembledJson as StreamAssembledLast | undefined,
      ...(assembledLast !== undefined
        ? { assembledLast: assembledLast as StreamAssembledLast }
        : {}),
      firstChunkMs,
      maxInterChunkMs,
      totalChunks: eventCount,
      totalBytes,
    },
    durationMs,
  };
}

/** Binary response path that streams directly to disk while hashing and truncating. */
async function executeBinaryResponse(
  request: ResolvedRequestModel,
  response: Response,
  startedAt: number,
  capture: CapturePolicy,
  hooks: HttpExecutionHooks,
  abortController: AbortController,
): Promise<HttpExecutionResult> {
  const { createHash } = await import("node:crypto");
  const { createWriteStream } = await import("node:fs");
  const { mkdir } = await import("node:fs/promises");
  const {
    dirname,
    isAbsolute,
    resolve: resolvePath,
  } = await import("node:path");

  if (!request.saveTo) {
    throw new HttpiError(
      "BINARY_SAVE_TO_REQUIRED",
      "response.mode: binary requires response.saveTo to be set.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  // Resolve relative paths against the process cwd (which is the project
  // root when invoked via CLI/MCP).
  const absolutePath = isAbsolute(request.saveTo)
    ? request.saveTo
    : resolvePath(process.cwd(), request.saveTo);

  await mkdir(dirname(absolutePath), { recursive: true });

  const maxBytes = request.responseMaxBytes ?? capture.maxBodyBytes;
  const hash = createHash("sha256");
  let total = 0;
  let truncated = false;
  const writer = createWriteStream(absolutePath, { flags: "w" });

  const body = response.body;
  if (!body) {
    writer.end();
    throw new HttpiError(
      "BINARY_NO_BODY",
      "Response has no body to download.",
      { exitCode: exitCodes.executionFailure },
    );
  }

  const reader = body.getReader();
  const shouldCancel = hooks.shouldCancel;
  let cancelled = false;
  try {
    while (true) {
      if (shouldCancel) {
        try {
          if (await shouldCancel()) {
            cancelled = true;
            abortController.abort();
            break;
          }
        } catch {
          // non-fatal
        }
      }
      const { done, value } = await reader.read();
      if (done) break;
      let slice = value;
      if (total + slice.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        slice = value.subarray(0, remaining);
        truncated = true;
      }
      if (slice.byteLength > 0) {
        hash.update(slice);
        await new Promise<void>((resolve, reject) => {
          writer.write(slice, (err) => (err ? reject(err) : resolve()));
        });
        total += slice.byteLength;
      }
      if (truncated) {
        abortController.abort();
        break;
      }
    }
  } finally {
    try {
      await reader.cancel().catch(() => undefined);
    } catch {
      // already closed
    }
    reader.releaseLock();
    await new Promise<void>((resolve) => writer.end(resolve));
  }

  if (cancelled) {
    throw new HttpiError(
      "HTTP_STREAM_CANCELLED",
      "Binary download was cancelled before completion.",
      { exitCode: exitCodes.executionFailure },
    );
  }

  if (truncated) {
    throw new HttpiError(
      "BINARY_MAXBYTES_EXCEEDED",
      `Binary response exceeded response.maxBytes=${maxBytes}.`,
      {
        exitCode: exitCodes.executionFailure,
        details: [
          {
            level: "error" as const,
            code: "BINARY_MAXBYTES_EXCEEDED",
            message: `Binary response was truncated at ${total} bytes.`,
            hint: "Increase response.maxBytes if the payload is legitimately larger, or investigate the upstream size.",
          },
        ],
      },
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const durationMs = Math.round(performance.now() - startedAt);
  const sha256Hex = hash.digest("hex");

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
      bodyBytes: total,
      contentType,
      truncated: false,
    },
    binary: {
      absolutePath,
      relativePath: request.saveTo,
      bytes: total,
      sha256: sha256Hex,
      truncated: false,
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

import type {
  AuthDefinition,
  BodyExpectation,
  CancelConfig,
  Diagnostic,
  JsonPathAssertion,
  RequestBodyDefinition,
  RequestDefinition,
  RequestExpectation,
  RequestUses,
  ResponseConfig,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
import { asRecord } from "@exit-zero-labs/httpi-shared";
import {
  expectRecord,
  isJsonValue,
  readHttpMethod,
  readLiteral,
  readOptionalBoolean,
  readOptionalFlatVariableMap,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringMap,
  readRequiredString,
} from "./parsing-helpers.js";

export function parseRequestDefinition(
  value: unknown,
  filePath: string,
): {
  value?: RequestDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "request");
  if (!record) {
    return { diagnostics };
  }

  const kind = readLiteral(record, "kind", "request", filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const method = readHttpMethod(record, filePath, diagnostics);
  const url = readRequiredString(
    record,
    "url",
    filePath,
    diagnostics,
    "Request definitions require a string url.",
  );
  const uses = parseRequestUses(record.uses, filePath, diagnostics);
  const defaults = readOptionalFlatVariableMap(
    record.defaults,
    filePath,
    diagnostics,
    "defaults",
  );
  const headers = readOptionalStringMap(
    record.headers,
    filePath,
    diagnostics,
    "headers",
  );
  const auth = parseOptionalAuthDefinition(
    record.auth,
    filePath,
    diagnostics,
    "auth",
  );
  const body = parseOptionalBodyDefinition(record.body, filePath, diagnostics);
  const response = parseOptionalResponseConfig(
    record.response,
    filePath,
    diagnostics,
  );
  const expect = parseOptionalExpect(record.expect, filePath, diagnostics);
  const extract = parseOptionalExtract(record.extract, filePath, diagnostics);
  const timeoutMs = readOptionalNumber(
    record,
    "timeoutMs",
    filePath,
    diagnostics,
  );
  const cancel = parseOptionalCancelConfig(
    record.cancel,
    filePath,
    diagnostics,
  );

  if (!kind || !method || !url) {
    return { diagnostics };
  }

  if (auth && uses?.auth) {
    diagnostics.push({
      level: "error",
      code: "AUTH_CONFLICT",
      message: "Requests may define inline auth or uses.auth, but not both.",
      filePath,
      path: "auth",
    });
  }

  const requestDefinition: RequestDefinition = {
    kind,
    title,
    method,
    url,
    uses,
    defaults,
    headers,
    auth,
    body,
    response,
    expect,
    extract,
    timeoutMs,
    cancel,
  };

  return {
    value: requestDefinition,
    diagnostics,
    title,
  };
}

function parseRequestUses(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestUses | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_REQUEST_USES",
      message: "uses must be an object when present.",
      filePath,
      path: "uses",
    });
    return undefined;
  }

  const headersValue = record.headers;
  let headers: string[] | undefined;
  if (headersValue !== undefined) {
    if (
      !Array.isArray(headersValue) ||
      headersValue.some((entry) => typeof entry !== "string")
    ) {
      diagnostics.push({
        level: "error",
        code: "INVALID_HEADER_REFERENCES",
        message: "uses.headers must be an array of strings.",
        filePath,
        path: "uses.headers",
      });
    } else {
      headers = headersValue;
    }
  }

  const auth = readOptionalString(
    record,
    "auth",
    filePath,
    diagnostics,
    "uses",
  );
  return {
    headers,
    auth,
  };
}

function parseOptionalExpect(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestExpectation | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXPECT",
      message: "expect must be an object when present.",
      filePath,
      path: "expect",
    });
    return undefined;
  }

  const result: RequestExpectation = {};

  // Status
  const status = record.status;
  if (status !== undefined) {
    if (typeof status === "number") {
      result.status = status;
    } else if (
      Array.isArray(status) &&
      status.every((entry) => typeof entry === "number")
    ) {
      result.status = status;
    } else {
      diagnostics.push({
        level: "error",
        code: "INVALID_EXPECT_STATUS",
        message: "expect.status must be a number or array of numbers.",
        filePath,
        path: "expect.status",
      });
    }
  }

  // Latency matcher (B1)
  if (record.latencyMs !== undefined) {
    const latencyRecord = asRecord(record.latencyMs);
    if (latencyRecord) {
      result.latencyMs = {
        lt: typeof latencyRecord.lt === "number" ? latencyRecord.lt : undefined,
        lte:
          typeof latencyRecord.lte === "number" ? latencyRecord.lte : undefined,
        gt: typeof latencyRecord.gt === "number" ? latencyRecord.gt : undefined,
        gte:
          typeof latencyRecord.gte === "number" ? latencyRecord.gte : undefined,
      };
    }
  }

  // Header matchers (B1)
  if (record.headers !== undefined) {
    const headersRecord = asRecord(record.headers);
    if (headersRecord) {
      const headerMatchers: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(headersRecord)) {
        if (typeof val === "string") {
          headerMatchers[key] = val;
        } else {
          const matcherRecord = asRecord(val);
          if (matcherRecord) {
            headerMatchers[key] = {
              startsWith:
                typeof matcherRecord.startsWith === "string"
                  ? matcherRecord.startsWith
                  : undefined,
              endsWith:
                typeof matcherRecord.endsWith === "string"
                  ? matcherRecord.endsWith
                  : undefined,
              equals:
                typeof matcherRecord.equals === "string"
                  ? matcherRecord.equals
                  : undefined,
              contains:
                typeof matcherRecord.contains === "string"
                  ? matcherRecord.contains
                  : undefined,
              matches:
                typeof matcherRecord.matches === "string"
                  ? matcherRecord.matches
                  : undefined,
              exists:
                typeof matcherRecord.exists === "boolean"
                  ? matcherRecord.exists
                  : undefined,
            };
          }
        }
      }
      result.headers = headerMatchers as RequestExpectation["headers"];
    }
  }

  // Body expectations (B1/B2)
  if (record.body !== undefined) {
    const bodyRecord = asRecord(record.body);
    if (bodyRecord) {
      result.body = parseBodyExpectation(bodyRecord);
    }
  }

  // Stream assertions (A1)
  if (record.stream !== undefined) {
    const streamRecord = asRecord(record.stream);
    if (streamRecord) {
      result.stream = {
        firstChunkWithinMs:
          typeof streamRecord.firstChunkWithinMs === "number"
            ? streamRecord.firstChunkWithinMs
            : undefined,
        maxInterChunkMs:
          typeof streamRecord.maxInterChunkMs === "number"
            ? streamRecord.maxInterChunkMs
            : undefined,
        minChunks:
          typeof streamRecord.minChunks === "number"
            ? streamRecord.minChunks
            : undefined,
      };
    }
  }

  return result;
}

function parseOptionalExtract(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestDefinition["extract"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXTRACT",
      message: "extract must be an object when present.",
      filePath,
      path: "extract",
    });
    return undefined;
  }

  const extractEntries: NonNullable<RequestDefinition["extract"]> = {};
  for (const [key, extractValue] of Object.entries(record)) {
    const extractRecord = asRecord(extractValue);
    if (!extractRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_EXTRACT_ENTRY",
        message: `extract.${key} must be an object.`,
        filePath,
        path: appendDiagnosticPath("extract", key),
      });
      continue;
    }

    const extractPath = appendDiagnosticPath("extract", key);
    const from = readRequiredString(
      extractRecord,
      "from",
      filePath,
      diagnostics,
      `extract.${key}.from must be a string.`,
      extractPath,
    );
    const required = readOptionalBoolean(
      extractRecord,
      "required",
      filePath,
      diagnostics,
      extractPath,
    );
    const secret = readOptionalBoolean(
      extractRecord,
      "secret",
      filePath,
      diagnostics,
      extractPath,
    );
    if (!from) {
      continue;
    }

    extractEntries[key] = {
      from,
      required,
      secret,
    };
  }

  return extractEntries;
}

function parseOptionalBodyDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestBodyDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_BODY",
      message: "body must be an object when present.",
      filePath,
      path: "body",
    });
    return undefined;
  }

  const contentType = readOptionalString(
    record,
    "contentType",
    filePath,
    diagnostics,
    "body",
  );
  if ("file" in record) {
    const file = readRequiredString(
      record,
      "file",
      filePath,
      diagnostics,
      "body.file must be a string.",
      "body",
    );
    if (!file) {
      return undefined;
    }

    return { file, contentType };
  }

  if ("json" in record) {
    const json = record.json;
    if (!isJsonValue(json)) {
      diagnostics.push({
        level: "error",
        code: "INVALID_JSON_BODY",
        message: "body.json must be valid JSON data.",
        filePath,
        path: "body.json",
      });
      return undefined;
    }

    return { json, contentType };
  }

  if ("text" in record) {
    const text = readRequiredString(
      record,
      "text",
      filePath,
      diagnostics,
      "body.text must be a string.",
      "body",
    );
    if (!text) {
      return undefined;
    }

    return { text, contentType };
  }

  if ("kind" in record && record.kind === "binary") {
    const file = readRequiredString(
      record,
      "file",
      filePath,
      diagnostics,
      "body.file must be a string for binary bodies.",
      "body",
    );
    if (!file) {
      return undefined;
    }
    return { kind: "binary", file, contentType };
  }

  if ("kind" in record && record.kind === "multipart") {
    const parts = record.parts;
    if (!Array.isArray(parts)) {
      diagnostics.push({
        level: "error",
        code: "INVALID_MULTIPART_PARTS",
        message: "body.parts must be an array for multipart bodies.",
        filePath,
        path: "body.parts",
      });
      return undefined;
    }
    const parsedParts = parts
      .map((part: unknown, index: number) => {
        const partRecord = asRecord(part);
        if (!partRecord) {
          diagnostics.push({
            level: "error",
            code: "INVALID_MULTIPART_PART",
            message: `body.parts[${index}] must be an object.`,
            filePath,
            path: `body.parts[${index}]`,
          });
          return undefined;
        }
        const name =
          typeof partRecord.name === "string" ? partRecord.name : undefined;
        if (!name) {
          diagnostics.push({
            level: "error",
            code: "INVALID_MULTIPART_PART_NAME",
            message: `body.parts[${index}].name must be a string.`,
            filePath,
            path: `body.parts[${index}].name`,
          });
          return undefined;
        }
        return {
          name,
          file:
            typeof partRecord.file === "string" ? partRecord.file : undefined,
          json:
            partRecord.json !== undefined && isJsonValue(partRecord.json)
              ? partRecord.json
              : undefined,
          text:
            typeof partRecord.text === "string" ? partRecord.text : undefined,
          contentType:
            typeof partRecord.contentType === "string"
              ? partRecord.contentType
              : undefined,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    return { kind: "multipart", parts: parsedParts };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_BODY_KIND",
    message:
      "body must define one of file, json, text, or kind (binary/multipart).",
    filePath,
    path: "body",
  });
  return undefined;
}

function parseOptionalAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseAuthDefinition(value, filePath, diagnostics, path);
}

export function parseAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_AUTH",
      message: `${path} must be an object.`,
      filePath,
      path,
    });
    return undefined;
  }

  const scheme = readRequiredString(
    record,
    "scheme",
    filePath,
    diagnostics,
    `${path}.scheme must be a string.`,
    path,
  );
  if (!scheme) {
    return undefined;
  }

  if (scheme === "bearer") {
    const token = readRequiredString(
      record,
      "token",
      filePath,
      diagnostics,
      `${path}.token must be a string.`,
      path,
    );
    if (!token) {
      return undefined;
    }

    return { scheme, token };
  }

  if (scheme === "basic") {
    const username = readRequiredString(
      record,
      "username",
      filePath,
      diagnostics,
      `${path}.username must be a string.`,
      path,
    );
    const password = readRequiredString(
      record,
      "password",
      filePath,
      diagnostics,
      `${path}.password must be a string.`,
      path,
    );
    if (!username || !password) {
      return undefined;
    }

    return {
      scheme,
      username,
      password,
    };
  }

  if (scheme === "header") {
    const header = readRequiredString(
      record,
      "header",
      filePath,
      diagnostics,
      `${path}.header must be a string.`,
      path,
    );
    const authValue = readRequiredString(
      record,
      "value",
      filePath,
      diagnostics,
      `${path}.value must be a string.`,
      path,
    );
    if (!header || !authValue) {
      return undefined;
    }

    return {
      scheme,
      header,
      value: authValue,
    };
  }

  if (scheme === "oauth2-client-credentials") {
    const tokenUrl = readRequiredString(
      record,
      "tokenUrl",
      filePath,
      diagnostics,
      `${path}.tokenUrl must be a string.`,
      path,
    );
    const clientId = readRequiredString(
      record,
      "clientId",
      filePath,
      diagnostics,
      `${path}.clientId must be a string.`,
      path,
    );
    const clientSecret = readRequiredString(
      record,
      "clientSecret",
      filePath,
      diagnostics,
      `${path}.clientSecret must be a string.`,
      path,
    );
    if (!tokenUrl || !clientId || !clientSecret) return undefined;
    const scope =
      Array.isArray(record.scope) &&
      record.scope.every((s: unknown) => typeof s === "string")
        ? (record.scope as string[])
        : undefined;
    const cacheKey =
      typeof record.cacheKey === "string" ? record.cacheKey : undefined;
    return { scheme, tokenUrl, clientId, clientSecret, scope, cacheKey };
  }

  if (scheme === "hmac") {
    const algorithm =
      typeof record.algorithm === "string" &&
      (record.algorithm === "sha256" || record.algorithm === "sha512")
        ? record.algorithm
        : undefined;
    if (!algorithm) {
      diagnostics.push({
        level: "error",
        code: "INVALID_HMAC_ALGORITHM",
        message: `${path}.algorithm must be sha256 or sha512.`,
        filePath,
        path: appendDiagnosticPath(path, "algorithm"),
      });
      return undefined;
    }
    const secret = readRequiredString(
      record,
      "secret",
      filePath,
      diagnostics,
      `${path}.secret must be a string.`,
      path,
    );
    const sign = readRequiredString(
      record,
      "sign",
      filePath,
      diagnostics,
      `${path}.sign must be a string.`,
      path,
    );
    if (!secret || !sign) return undefined;
    const keyId = typeof record.keyId === "string" ? record.keyId : undefined;
    const headers =
      record.headers !== undefined
        ? (asRecord(record.headers) as Record<string, string> | undefined)
        : undefined;
    return { scheme, algorithm, keyId, secret, sign, headers };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_AUTH_SCHEME",
    message: `${path}.scheme must be one of bearer, basic, header, oauth2-client-credentials, or hmac.`,
    filePath,
    path: appendDiagnosticPath(path, "scheme"),
  });
  return undefined;
}

function parseOptionalResponseConfig(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): ResponseConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_RESPONSE",
      message: "response must be an object when present.",
      filePath,
      path: "response",
    });
    return undefined;
  }

  const validModes = ["buffered", "stream", "binary"];
  const mode =
    typeof record.mode === "string" && validModes.includes(record.mode)
      ? (record.mode as ResponseConfig["mode"])
      : undefined;

  if (record.mode !== undefined && !mode) {
    diagnostics.push({
      level: "error",
      code: "INVALID_RESPONSE_MODE",
      message: `response.mode must be one of: ${validModes.join(", ")}.`,
      filePath,
      path: "response.mode",
    });
  }

  let stream: ResponseConfig["stream"];
  if (record.stream !== undefined) {
    const streamRecord = asRecord(record.stream);
    if (!streamRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STREAM_CONFIG",
        message: "response.stream must be an object.",
        filePath,
        path: "response.stream",
      });
    } else {
      const validParseModes = ["sse", "ndjson", "chunked-json"];
      const parse =
        typeof streamRecord.parse === "string" &&
        validParseModes.includes(streamRecord.parse)
          ? (streamRecord.parse as "sse" | "ndjson" | "chunked-json")
          : undefined;
      if (!parse) {
        diagnostics.push({
          level: "error",
          code: "INVALID_STREAM_PARSE",
          message: `response.stream.parse must be one of: ${validParseModes.join(", ")}.`,
          filePath,
          path: "response.stream.parse",
        });
      } else {
        stream = {
          parse,
          capture:
            typeof streamRecord.capture === "string" &&
            ["chunks", "final", "both"].includes(streamRecord.capture)
              ? (streamRecord.capture as "chunks" | "final" | "both")
              : undefined,
          maxBytes:
            typeof streamRecord.maxBytes === "number"
              ? streamRecord.maxBytes
              : undefined,
        };
      }
    }
  }

  return {
    mode,
    stream,
    saveTo: typeof record.saveTo === "string" ? record.saveTo : undefined,
    maxBytes: typeof record.maxBytes === "number" ? record.maxBytes : undefined,
  };
}

function parseBodyExpectation(
  bodyRecord: Record<string, unknown>,
): BodyExpectation {
  return {
    contentType:
      typeof bodyRecord.contentType === "string"
        ? bodyRecord.contentType
        : undefined,
    kind:
      typeof bodyRecord.kind === "string" &&
      (bodyRecord.kind === "json-schema" || bodyRecord.kind === "snapshot")
        ? bodyRecord.kind
        : undefined,
    schema:
      typeof bodyRecord.schema === "string" ? bodyRecord.schema : undefined,
    draft: typeof bodyRecord.draft === "string" ? bodyRecord.draft : undefined,
    file: typeof bodyRecord.file === "string" ? bodyRecord.file : undefined,
    jsonPath: Array.isArray(bodyRecord.jsonPath)
      ? parseJsonPathAssertions(bodyRecord.jsonPath)
      : undefined,
    contains:
      Array.isArray(bodyRecord.contains) &&
      bodyRecord.contains.every((s: unknown) => typeof s === "string")
        ? (bodyRecord.contains as string[])
        : undefined,
    not: parseNotBlock(bodyRecord.not),
    mask: parseMaskArray(bodyRecord.mask),
  };
}

function parseJsonPathAssertions(entries: unknown[]): JsonPathAssertion[] {
  const result: JsonPathAssertion[] = [];
  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    if (!entryRecord || typeof entryRecord.path !== "string") continue;
    result.push({
      path: entryRecord.path,
      equals:
        entryRecord.equals !== undefined && isJsonValue(entryRecord.equals)
          ? entryRecord.equals
          : undefined,
      length: parseJsonPathLength(entryRecord.length),
      matches:
        typeof entryRecord.matches === "string"
          ? entryRecord.matches
          : undefined,
      exists:
        typeof entryRecord.exists === "boolean"
          ? entryRecord.exists
          : undefined,
      gte: typeof entryRecord.gte === "number" ? entryRecord.gte : undefined,
      lte: typeof entryRecord.lte === "number" ? entryRecord.lte : undefined,
      gt: typeof entryRecord.gt === "number" ? entryRecord.gt : undefined,
      lt: typeof entryRecord.lt === "number" ? entryRecord.lt : undefined,
    });
  }
  return result;
}

function parseJsonPathLength(value: unknown): JsonPathAssertion["length"] {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const record = asRecord(value);
  if (!record) return undefined;
  const result: { gte?: number; lte?: number; gt?: number; lt?: number } = {};
  if (typeof record.gte === "number") result.gte = record.gte;
  if (typeof record.lte === "number") result.lte = record.lte;
  if (typeof record.gt === "number") result.gt = record.gt;
  if (typeof record.lt === "number") result.lt = record.lt;
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

function parseNotBlock(value: unknown): BodyExpectation["not"] {
  if (value === undefined) return undefined;
  const notRecord = asRecord(value);
  if (!notRecord) return undefined;

  const jsonPath = Array.isArray(notRecord.jsonPath)
    ? parseJsonPathAssertions(notRecord.jsonPath)
    : undefined;

  const contains =
    Array.isArray(notRecord.contains) &&
    notRecord.contains.every((s: unknown) => typeof s === "string")
      ? (notRecord.contains as string[])
      : undefined;

  return {
    jsonPath: jsonPath && jsonPath.length > 0 ? jsonPath : undefined,
    contains,
  };
}

function parseMaskArray(value: unknown): Array<{ path: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ path: string }> = [];
  for (const entry of value) {
    const entryRecord = asRecord(entry);
    if (!entryRecord || typeof entryRecord.path !== "string") continue;
    result.push({ path: entryRecord.path });
  }
  return result.length > 0 ? result : undefined;
}

function parseOptionalCancelConfig(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): CancelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_CANCEL",
      message: "cancel must be an object when present.",
      filePath,
      path: "cancel",
    });
    return undefined;
  }

  return {
    onRunTimeout:
      typeof record.onRunTimeout === "boolean"
        ? record.onRunTimeout
        : undefined,
    onSignal:
      Array.isArray(record.onSignal) &&
      record.onSignal.every((s: unknown) => typeof s === "string")
        ? record.onSignal
        : undefined,
  };
}

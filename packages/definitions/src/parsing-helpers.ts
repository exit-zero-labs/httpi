import type {
  CapturePolicy,
  Diagnostic,
  FlatVariableMap,
  FlatVariableValue,
  HttpMethod,
  JsonValue,
  LoadedDefinition,
} from "@exit-zero-labs/httpi-contracts";
import {
  appendDiagnosticPath,
  schemaVersion,
} from "@exit-zero-labs/httpi-contracts";
import {
  asRecord,
  looksLikeSecretFieldName,
} from "@exit-zero-labs/httpi-shared";

export type DefinitionParser<TValue> = (
  value: unknown,
  filePath: string,
) => {
  value?: TValue;
  diagnostics: Diagnostic[];
  title?: string | undefined;
};

export const defaultCapturePolicy: CapturePolicy = {
  requestSummary: true,
  responseMetadata: true,
  responseBody: "full",
  maxBodyBytes: 1024 * 1024,
  redactHeaders: ["authorization", "cookie", "set-cookie"],
};

const supportedMethods = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function readSchemaVersion(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): typeof schemaVersion | undefined {
  const rawValue = record.schemaVersion;
  if (rawValue !== schemaVersion) {
    diagnostics.push({
      level: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `schemaVersion must be ${schemaVersion}.`,
      filePath,
      path: "schemaVersion",
    });
    return undefined;
  }

  return schemaVersion;
}

export function readOptionalSchemaVersion(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): typeof schemaVersion | undefined {
  if (record.schemaVersion === undefined) {
    return undefined;
  }

  if (record.schemaVersion !== schemaVersion) {
    diagnostics.push({
      level: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `schemaVersion must be ${schemaVersion}.`,
      filePath,
      path: "schemaVersion",
    });
    return undefined;
  }

  return schemaVersion;
}

export function normalizeCapturePolicy(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): CapturePolicy {
  if (value === undefined) {
    return defaultCapturePolicy;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_CAPTURE",
      message: "capture must be an object when present.",
      filePath,
      path: "capture",
    });
    return defaultCapturePolicy;
  }

  const requestSummary =
    readOptionalBoolean(
      record,
      "requestSummary",
      filePath,
      diagnostics,
      "capture",
    ) ??
    defaultCapturePolicy.requestSummary;
  const responseMetadata =
    readOptionalBoolean(
      record,
      "responseMetadata",
      filePath,
      diagnostics,
      "capture",
    ) ??
    defaultCapturePolicy.responseMetadata;

  let responseBody = defaultCapturePolicy.responseBody;
  if (record.responseBody !== undefined) {
    if (
      record.responseBody === "full" ||
      record.responseBody === "metadata" ||
      record.responseBody === "none"
    ) {
      responseBody = record.responseBody;
    } else {
      diagnostics.push({
        level: "error",
        code: "INVALID_RESPONSE_BODY_POLICY",
        message: "capture.responseBody must be full, metadata, or none.",
        filePath,
        path: "capture.responseBody",
      });
    }
  }

  const maxBodyBytes =
    readOptionalNumber(
      record,
      "maxBodyBytes",
      filePath,
      diagnostics,
      "capture",
    ) ??
    defaultCapturePolicy.maxBodyBytes;

  const redactHeadersValue = record.redactHeaders;
  let redactHeaders = defaultCapturePolicy.redactHeaders;
  if (redactHeadersValue !== undefined) {
    if (
      Array.isArray(redactHeadersValue) &&
      redactHeadersValue.every((entry) => typeof entry === "string")
    ) {
      redactHeaders = redactHeadersValue;
    } else {
      diagnostics.push({
        level: "error",
        code: "INVALID_REDACT_HEADERS",
        message: "capture.redactHeaders must be an array of strings.",
        filePath,
        path: "capture.redactHeaders",
      });
    }
  }

  return {
    requestSummary,
    responseMetadata,
    responseBody,
    maxBodyBytes,
    redactHeaders,
  };
}

export function readHttpMethod(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
  pathPrefix?: string,
): HttpMethod | undefined {
  const rawMethod = readRequiredString(
    record,
    "method",
    filePath,
    diagnostics,
    "Request definitions require a string method.",
    pathPrefix,
  );
  if (!rawMethod) {
    return undefined;
  }

  const normalizedMethod = rawMethod.toUpperCase();
  if (!supportedMethods.has(normalizedMethod as HttpMethod)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_HTTP_METHOD",
      message: `Unsupported HTTP method ${rawMethod}.`,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, "method"),
    });
    return undefined;
  }

  return normalizedMethod as HttpMethod;
}

export function expectRecord(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  label: string,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_FILE_SHAPE",
      message: `${label} definitions must be objects.`,
      filePath,
    });
  }

  return record;
}

export function readLiteral<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  expectedValue: TValue,
  filePath: string,
  diagnostics: Diagnostic[],
  pathPrefix?: string,
): TValue | undefined {
  if (record[key] !== expectedValue) {
    diagnostics.push({
      level: "error",
      code: "INVALID_LITERAL",
      message: `${key} must be ${expectedValue}.`,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, key),
    });
    return undefined;
  }

  return expectedValue;
}

export function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
  message: string,
  pathPrefix?: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    const typoKey = value === undefined ? findLikelyTypoKey(record, key) : undefined;
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING",
      message: typoKey ? `${message} Found ${typoKey} instead.` : message,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, typoKey ?? key),
    });
    return undefined;
  }

  return value;
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
  pathPrefix?: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING",
      message: `${key} must be a string when present.`,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, key),
    });
    return undefined;
  }

  return value;
}

export function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
  pathPrefix?: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    diagnostics.push({
      level: "error",
      code: "INVALID_BOOLEAN",
      message: `${key} must be a boolean when present.`,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, key),
    });
    return undefined;
  }

  return value;
}

export function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
  pathPrefix?: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_NUMBER",
      message: `${key} must be a number when present.`,
      filePath,
      path: resolveDiagnosticKeyPath(pathPrefix, key),
    });
    return undefined;
  }

  return value;
}

export function readFlatVariableMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): FlatVariableMap {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_VARIABLE_MAP",
      message: `${path} must be an object with primitive values.`,
      filePath,
      path,
    });
    return {};
  }

  return Object.entries(record).reduce<FlatVariableMap>(
    (result, [key, entry]) => {
      if (isFlatVariableValue(entry)) {
        result[key] = entry;
        return result;
      }

      diagnostics.push({
        level: "error",
        code: "INVALID_VARIABLE_VALUE",
        message: `${path}.${key} must be a string, number, boolean, or null.`,
        filePath,
        path: appendDiagnosticPath(path, key),
      });
      return result;
    },
    {},
  );
}

export function readOptionalFlatVariableMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): FlatVariableMap | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readFlatVariableMap(value, filePath, diagnostics, path);
}

export function readStringMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING_MAP",
      message: `${path} must be an object with string values.`,
      filePath,
      path,
    });
    return {};
  }

  return Object.entries(record).reduce<Record<string, string>>(
    (result, [key, entry]) => {
      if (typeof entry === "string") {
        result[key] = entry;
        return result;
      }

      diagnostics.push({
        level: "error",
        code: "INVALID_STRING_MAP_VALUE",
        message: `${path}.${key} must be a string.`,
        filePath,
        path: appendDiagnosticPath(path, key),
      });
      return result;
    },
    {},
  );
}

export function readOptionalStringMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStringMap(value, filePath, diagnostics, path);
}

function resolveDiagnosticKeyPath(
  pathPrefix: string | undefined,
  key: string,
): string {
  return pathPrefix ? appendDiagnosticPath(pathPrefix, key) : key;
}

function findLikelyTypoKey(
  record: Record<string, unknown>,
  expectedKey: string,
): string | undefined {
  let closestKey: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const existingKey of Object.keys(record)) {
    const distance = levenshteinDistance(existingKey, expectedKey);
    if (distance >= closestDistance) {
      continue;
    }

    closestDistance = distance;
    closestKey = existingKey;
  }

  return closestDistance <= 2 ? closestKey : undefined;
}

function levenshteinDistance(left: string, right: string): number {
  const previousRow = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  const currentRow = new Array<number>(right.length + 1);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    currentRow[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      currentRow[rightIndex + 1] = Math.min(
        (currentRow[rightIndex] ?? 0) + 1,
        (previousRow[rightIndex + 1] ?? 0) + 1,
        (previousRow[rightIndex] ?? 0) + substitutionCost,
      );
    }

    for (let index = 0; index < currentRow.length; index += 1) {
      previousRow[index] = currentRow[index] ?? previousRow[index] ?? 0;
    }
  }

  return previousRow[right.length] ?? 0;
}

export function isFlatVariableValue(
  value: unknown,
): value is FlatVariableValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (isFlatVariableValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return Object.values(record).every((entry) => isJsonValue(entry));
}

export function detectSecretLiteralDiagnostics(
  value: unknown,
  filePath: string,
  kind: LoadedDefinition<unknown>["kind"],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  visitValue(value, [], (pathSegments, currentValue) => {
    const lastSegment = pathSegments.at(-1);
    if (typeof currentValue !== "string" || !lastSegment) {
      return;
    }

    const joinedPath = joinDiagnosticPath(pathSegments);
    const isSecretishField = looksLikeSecretFieldName(lastSegment);
    const isSecretHeaderValue =
      pathSegments.length >= 2 &&
      pathSegments[pathSegments.length - 2] === "headers" &&
      looksLikeSecretFieldName(lastSegment);
    const isHeaderAuthValue = isHeaderAuthValuePath(value, pathSegments);

    if (!isSecretishField && !isSecretHeaderValue && !isHeaderAuthValue) {
      return;
    }

    if (
      currentValue.startsWith("{{") ||
      currentValue.startsWith("$ENV:") ||
      currentValue === ""
    ) {
      return;
    }

    diagnostics.push({
      level: "error",
      code: "SECRET_LITERAL",
      message: `Tracked ${kind} file contains a likely secret literal at ${joinedPath}. Use {{secrets.*}} or $ENV:NAME instead.`,
      filePath,
      path: joinedPath,
    });
  });

  return diagnostics;
}

function isHeaderAuthValuePath(
  rootValue: unknown,
  pathSegments: string[],
): boolean {
  if (pathSegments.at(-1) !== "value") {
    return false;
  }

  const parentValue = getValueAtPath(rootValue, pathSegments.slice(0, -1));
  if (typeof parentValue !== "object" || parentValue === null) {
    return false;
  }

  return (
    "scheme" in parentValue &&
    parentValue.scheme === "header" &&
    "header" in parentValue &&
    typeof parentValue.header === "string"
  );
}

function visitValue(
  value: unknown,
  pathSegments: string[],
  visitor: (pathSegments: string[], value: unknown) => void,
): void {
  visitor(pathSegments, value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitValue(entry, [...pathSegments, String(index)], visitor);
    });
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const [key, entry] of Object.entries(record)) {
    visitValue(entry, [...pathSegments, key], visitor);
  }
}

function getValueAtPath(value: unknown, pathSegments: string[]): unknown {
  let currentValue = value;
  for (const pathSegment of pathSegments) {
    if (Array.isArray(currentValue)) {
      const nextIndex = Number(pathSegment);
      currentValue = currentValue.at(nextIndex);
      continue;
    }

    const record = asRecord(currentValue);
    if (!record) {
      return undefined;
    }
    currentValue = record[pathSegment];
  }

  return currentValue;
}

function joinDiagnosticPath(pathSegments: string[]): string {
  let path = "";

  for (const segment of pathSegments) {
    const normalizedSegment = /^\d+$/.test(segment)
      ? Number(segment)
      : segment;
    if (!path) {
      path =
        typeof normalizedSegment === "number"
          ? `[${normalizedSegment}]`
          : normalizedSegment;
      continue;
    }

    path = appendDiagnosticPath(path, normalizedSegment);
  }

  return path;
}

import type {
  CompiledRequestStep,
  FlatVariableValue,
  HttpExecutionResult,
  JsonValue,
} from "@exit-zero-labs/httpi-contracts";
import {
  exitCodes,
  HttpiError,
  looksLikeSecretFieldName,
} from "@exit-zero-labs/httpi-shared";
import type { ExtractedStepOutputs } from "./types.js";

export function extractStepOutputs(
  step: CompiledRequestStep,
  exchange: HttpExecutionResult,
): ExtractedStepOutputs {
  const extractDefinitions = step.request.extract;
  const extractKeys = Object.keys(extractDefinitions);
  if (extractKeys.length === 0) {
    return {
      values: {},
      secretOutputKeys: [],
    };
  }

  const responseBody = exchange.response.bodyText;
  const parsedBody = responseBody ? safeJsonParse(responseBody) : undefined;
  const extractedValues: Record<string, FlatVariableValue> = {};
  const secretOutputKeys = new Set<string>();

  for (const [name, definition] of Object.entries(extractDefinitions)) {
    const extractedValue = readJsonPath(parsedBody, definition.from);
    if (extractedValue === undefined) {
      if (definition.required) {
        throw new HttpiError(
          "EXTRACTION_FAILED",
          `Required extraction ${name} was not found at ${definition.from}.`,
          { exitCode: exitCodes.executionFailure },
        );
      }
      continue;
    }

    extractedValues[name] = coerceToFlatVariableValue(extractedValue);
    if (
      definition.secret ||
      looksLikeSecretFieldName(name) ||
      extractionPathLooksSecret(definition.from)
    ) {
      secretOutputKeys.add(name);
    }
  }

  return {
    values: extractedValues,
    secretOutputKeys: [...secretOutputKeys].sort(),
  };
}

function safeJsonParse(value: string): JsonValue | undefined {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function readJsonPath(value: JsonValue | undefined, path: string): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (path === "$") {
    return value;
  }

  if (!path.startsWith("$.")) {
    return undefined;
  }

  const segments = path.slice(2).split(".");
  let currentValue: unknown = value;

  for (const segment of segments) {
    const segmentMatch = segment.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
    if (!segmentMatch) {
      return undefined;
    }

    const propertyName = segmentMatch[1];
    const indexValue = segmentMatch[2];
    if (!propertyName) {
      return undefined;
    }

    if (
      typeof currentValue !== "object" ||
      currentValue === null ||
      Array.isArray(currentValue)
    ) {
      return undefined;
    }

    const record = currentValue as Record<string, unknown>;
    currentValue = record[propertyName];

    if (indexValue !== undefined) {
      if (!Array.isArray(currentValue)) {
        return undefined;
      }

      currentValue = currentValue[Number(indexValue)];
    }
  }

  return currentValue;
}

function coerceToFlatVariableValue(value: unknown): FlatVariableValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  return JSON.stringify(value);
}

function extractionPathLooksSecret(path: string): boolean {
  if (!path.startsWith("$.")) {
    return false;
  }

  return path
    .slice(2)
    .split(".")
    .some((segment) => {
      const segmentMatch = segment.match(/^([^[\]]+)/);
      return segmentMatch?.[1]
        ? looksLikeSecretFieldName(segmentMatch[1])
        : false;
    });
}

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import type {
  AssertionResult,
  JsonValue,
} from "@exit-zero-labs/httpi-contracts";
import { exitCodes, HttpiError } from "@exit-zero-labs/httpi-shared";

/**
 * Minimal JSON Schema (draft 2020-12 subset) evaluator used by the `expect`
 * DSL. It intentionally supports only the keywords needed by the httpi
 * assertion surface: type, required, properties, additionalProperties, items,
 * enum, const, minimum, maximum, minLength, maxLength, pattern, minItems,
 * maxItems, uniqueItems. Results are emitted as `AssertionResult` entries so
 * they plug into the same structured-diagnostic channel as other assertions.
 */

export interface SchemaLoadOptions {
  projectRoot: string;
  baseFilePath?: string | undefined;
}

type AnySchema =
  | {
      type?: string | string[];
      required?: string[];
      properties?: Record<string, AnySchema>;
      additionalProperties?: boolean | AnySchema;
      items?: AnySchema;
      enum?: JsonValue[];
      const?: JsonValue;
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      exclusiveMaximum?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
      oneOf?: AnySchema[];
      anyOf?: AnySchema[];
      allOf?: AnySchema[];
      not?: AnySchema;
    }
  | Record<string, unknown>;

export async function loadJsonSchema(
  schemaPath: string,
  options: SchemaLoadOptions,
): Promise<AnySchema> {
  const candidate = resolveSchemaPath(schemaPath, options);
  let raw: string;
  try {
    raw = await readFile(candidate, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown filesystem error";
    throw new HttpiError(
      "SCHEMA_NOT_FOUND",
      `Could not read JSON schema at ${candidate}: ${message}`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  try {
    return JSON.parse(raw) as AnySchema;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown JSON parse error";
    throw new HttpiError(
      "SCHEMA_INVALID_JSON",
      `JSON schema at ${candidate} is not valid JSON: ${message}`,
      { exitCode: exitCodes.validationFailure },
    );
  }
}

function resolveSchemaPath(
  schemaPath: string,
  options: SchemaLoadOptions,
): string {
  if (isAbsolute(schemaPath)) return schemaPath;
  if (options.baseFilePath) {
    const candidate = resolvePath(dirname(options.baseFilePath), schemaPath);
    return candidate;
  }
  return resolvePath(options.projectRoot, schemaPath);
}

export interface ValidateAgainstSchemaOptions {
  basePath: string;
  matcher?: string;
}

export function validateAgainstSchema(
  schema: AnySchema,
  instance: unknown,
  options: ValidateAgainstSchemaOptions,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  walk(
    schema,
    instance,
    options.basePath,
    options.matcher ?? "json-schema",
    results,
  );
  if (results.length === 0) {
    results.push({
      path: options.basePath,
      matcher: options.matcher ?? "json-schema",
      expected: "schema-valid",
      actual: "schema-valid",
      passed: true,
    });
  }
  return results;
}

function walk(
  schema: AnySchema,
  instance: unknown,
  path: string,
  matcher: string,
  out: AssertionResult[],
): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as AnySchema & Record<string, unknown>;

  if (s.const !== undefined) {
    const passed = JSON.stringify(instance) === JSON.stringify(s.const);
    if (!passed)
      out.push(mkResult(path, matcher, "const", s.const, instance, false));
  }

  if (Array.isArray(s.enum)) {
    const passed = s.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(instance),
    );
    if (!passed)
      out.push(
        mkResult(path, matcher, "enum", s.enum as JsonValue, instance, false),
      );
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actualType = typeOf(instance);
    const passed = types.some((t) => matchesType(t, instance, actualType));
    if (!passed)
      out.push(
        mkResult(path, matcher, "type", s.type as JsonValue, actualType, false),
      );
  }

  if (typeof instance === "string") {
    if (typeof s.minLength === "number" && instance.length < s.minLength) {
      out.push(
        mkResult(
          path,
          matcher,
          "minLength",
          s.minLength,
          instance.length,
          false,
        ),
      );
    }
    if (typeof s.maxLength === "number" && instance.length > s.maxLength) {
      out.push(
        mkResult(
          path,
          matcher,
          "maxLength",
          s.maxLength,
          instance.length,
          false,
        ),
      );
    }
    if (typeof s.pattern === "string") {
      try {
        const re = new RegExp(s.pattern);
        if (!re.test(instance))
          out.push(
            mkResult(path, matcher, "pattern", s.pattern, instance, false),
          );
      } catch {
        out.push(
          mkResult(
            path,
            matcher,
            "pattern",
            s.pattern,
            "<invalid regex>",
            false,
          ),
        );
      }
    }
  }

  if (typeof instance === "number") {
    if (typeof s.minimum === "number" && instance < s.minimum) {
      out.push(mkResult(path, matcher, "minimum", s.minimum, instance, false));
    }
    if (typeof s.maximum === "number" && instance > s.maximum) {
      out.push(mkResult(path, matcher, "maximum", s.maximum, instance, false));
    }
    if (
      typeof s.exclusiveMinimum === "number" &&
      instance <= s.exclusiveMinimum
    ) {
      out.push(
        mkResult(
          path,
          matcher,
          "exclusiveMinimum",
          s.exclusiveMinimum,
          instance,
          false,
        ),
      );
    }
    if (
      typeof s.exclusiveMaximum === "number" &&
      instance >= s.exclusiveMaximum
    ) {
      out.push(
        mkResult(
          path,
          matcher,
          "exclusiveMaximum",
          s.exclusiveMaximum,
          instance,
          false,
        ),
      );
    }
  }

  if (Array.isArray(instance)) {
    if (typeof s.minItems === "number" && instance.length < s.minItems) {
      out.push(
        mkResult(path, matcher, "minItems", s.minItems, instance.length, false),
      );
    }
    if (typeof s.maxItems === "number" && instance.length > s.maxItems) {
      out.push(
        mkResult(path, matcher, "maxItems", s.maxItems, instance.length, false),
      );
    }
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      let duplicate = false;
      for (const item of instance) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          duplicate = true;
          break;
        }
        seen.add(key);
      }
      if (duplicate)
        out.push(mkResult(path, matcher, "uniqueItems", true, false, false));
    }
    if (s.items && typeof s.items === "object") {
      for (let i = 0; i < instance.length; i++) {
        walk(s.items as AnySchema, instance[i], `${path}[${i}]`, matcher, out);
      }
    }
  }

  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    const obj = instance as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (!(key in obj)) {
          out.push(
            mkResult(`${path}.${key}`, matcher, "required", true, null, false),
          );
        }
      }
    }
    const props = (s.properties ?? {}) as Record<string, AnySchema>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) {
        walk(propSchema, obj[key], `${path}.${key}`, matcher, out);
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          out.push(
            mkResult(
              `${path}.${key}`,
              matcher,
              "additionalProperties",
              false,
              key,
              false,
            ),
          );
        }
      }
    } else if (
      s.additionalProperties &&
      typeof s.additionalProperties === "object"
    ) {
      for (const [key, value] of Object.entries(obj)) {
        if (!(key in props)) {
          walk(
            s.additionalProperties as AnySchema,
            value,
            `${path}.${key}`,
            matcher,
            out,
          );
        }
      }
    }
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) walk(sub, instance, path, matcher, out);
  }
  if (Array.isArray(s.anyOf)) {
    const buffers = s.anyOf.map((sub) => {
      const inner: AssertionResult[] = [];
      walk(sub, instance, path, matcher, inner);
      return inner;
    });
    const any = buffers.some((b) => b.length === 0);
    if (!any)
      out.push(mkResult(path, matcher, "anyOf", s.anyOf.length, 0, false));
  }
  if (Array.isArray(s.oneOf)) {
    const passCount = s.oneOf.filter((sub) => {
      const inner: AssertionResult[] = [];
      walk(sub, instance, path, matcher, inner);
      return inner.length === 0;
    }).length;
    if (passCount !== 1)
      out.push(mkResult(path, matcher, "oneOf", 1, passCount, false));
  }
  if (s.not && typeof s.not === "object") {
    const inner: AssertionResult[] = [];
    walk(s.not as AnySchema, instance, path, matcher, inner);
    if (inner.length === 0)
      out.push(mkResult(path, matcher, "not", "no-match", "matched", false));
  }
}

function mkResult(
  path: string,
  matcher: string,
  keyword: string,
  expected: unknown,
  actual: unknown,
  passed: boolean,
): AssertionResult {
  return {
    path,
    matcher: `${matcher}.${keyword}`,
    expected: expected as JsonValue,
    actual: actual as JsonValue,
    passed,
  };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(
  expected: string,
  value: unknown,
  actualType: string,
): boolean {
  if (expected === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return actualType === expected;
}

import type {
  AggregateExpectation,
  AssertionResult,
  BodyExpectation,
  HeaderMatcher,
  HttpExecutionResult,
  JsonPathAssertion,
  JsonValue,
  LatencyMatcher,
  RequestExpectation,
} from "@exit-zero-labs/httpi-contracts";
import { loadJsonSchema, validateAgainstSchema } from "./json-schema.js";
import type { AggregateSummary } from "./percentiles.js";
import { extractJsonPath } from "./request-outputs.js";
import { evaluateSnapshotAssertion } from "./snapshot.js";

export interface SchemaAssertionContext {
  projectRoot: string;
  requestFilePath?: string | undefined;
}

export async function evaluateSchemaAssertions(
  expect: RequestExpectation,
  exchange: HttpExecutionResult,
  ctx: SchemaAssertionContext,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const schemaOptions = {
    projectRoot: ctx.projectRoot,
    ...(ctx.requestFilePath ? { baseFilePath: ctx.requestFilePath } : {}),
  };

  // Stream finalAssembled schema (A1)
  if (
    expect.stream?.finalAssembled?.kind === "json-schema" &&
    exchange.stream
  ) {
    // Prefer assembledLast for SSE/NDJSON (the terminal frame), fall back to
    // assembledJson and then the raw text. This matches the AI use case where
    // the final frame is the validated document.
    const instance =
      exchange.stream.assembledLast !== undefined
        ? exchange.stream.assembledLast
        : exchange.stream.assembledJson !== undefined
          ? exchange.stream.assembledJson
          : safeParseJson(exchange.stream.assembledText ?? "");
    try {
      const schema = await loadJsonSchema(
        expect.stream.finalAssembled.schema,
        schemaOptions,
      );
      const schemaResults = validateAgainstSchema(schema, instance, {
        basePath: "stream.finalAssembled",
        matcher: "json-schema",
      });
      for (const r of schemaResults) if (!r.passed) results.push(r);
    } catch (error) {
      results.push({
        path: "stream.finalAssembled",
        matcher: "json-schema.load",
        expected: expect.stream.finalAssembled.schema,
        actual: error instanceof Error ? error.message : "schema load failure",
        passed: false,
      });
    }
  }

  // B3 snapshot assertion — uses masked JSON Patch diff.
  if (expect.body?.kind === "snapshot" && expect.body.file) {
    const snapshotResults = await evaluateSnapshotAssertion(
      expect.body,
      exchange,
      {
        projectRoot: ctx.projectRoot,
        ...(ctx.requestFilePath
          ? { requestFilePath: ctx.requestFilePath }
          : {}),
      },
    );
    for (const r of snapshotResults) if (!r.passed) results.push(r);
  }

  // Body json-schema (B1/B3)
  if (expect.body?.kind === "json-schema" && expect.body.schema) {
    const bodyText = exchange.response.bodyText ?? "";
    const instance = safeParseJson(bodyText);
    try {
      const schema = await loadJsonSchema(expect.body.schema, schemaOptions);
      const schemaResults = validateAgainstSchema(schema, instance, {
        basePath: "body",
        matcher: "json-schema",
      });
      for (const r of schemaResults) if (!r.passed) results.push(r);
    } catch (error) {
      results.push({
        path: "body",
        matcher: "json-schema.load",
        expected: expect.body.schema,
        actual: error instanceof Error ? error.message : "schema load failure",
        passed: false,
      });
    }
  }

  return results;
}

export function evaluateAggregateAssertions(
  expect: AggregateExpectation,
  summary: AggregateSummary,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (expect.latencyMs) {
    const p = expect.latencyMs;
    if (p.p50) {
      results.push(
        ...compareLatency(
          "aggregate.latencyMs.p50",
          p.p50,
          summary.latencyMs.p50,
        ),
      );
    }
    if (p.p95) {
      results.push(
        ...compareLatency(
          "aggregate.latencyMs.p95",
          p.p95,
          summary.latencyMs.p95,
        ),
      );
    }
    if (p.p99) {
      results.push(
        ...compareLatency(
          "aggregate.latencyMs.p99",
          p.p99,
          summary.latencyMs.p99,
        ),
      );
    }
  }
  if (expect.errorRate) {
    results.push(
      ...compareLatency(
        "aggregate.errorRate",
        expect.errorRate,
        summary.errorRate,
      ),
    );
  }
  return results;
}

function compareLatency(
  path: string,
  matcher: LatencyMatcher,
  actual: number,
): AssertionResult[] {
  const out: AssertionResult[] = [];
  if (matcher.lt !== undefined) {
    out.push({
      path,
      matcher: "lt",
      expected: matcher.lt,
      actual,
      passed: actual < matcher.lt,
    });
  }
  if (matcher.lte !== undefined) {
    out.push({
      path,
      matcher: "lte",
      expected: matcher.lte,
      actual,
      passed: actual <= matcher.lte,
    });
  }
  if (matcher.gt !== undefined) {
    out.push({
      path,
      matcher: "gt",
      expected: matcher.gt,
      actual,
      passed: actual > matcher.gt,
    });
  }
  if (matcher.gte !== undefined) {
    out.push({
      path,
      matcher: "gte",
      expected: matcher.gte,
      actual,
      passed: actual >= matcher.gte,
    });
  }
  return out;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function evaluateAssertions(
  expect: RequestExpectation,
  exchange: HttpExecutionResult,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  // Status assertion
  if (expect.status !== undefined) {
    results.push(
      evaluateStatusAssertion(expect.status, exchange.response.status),
    );
  }

  // Latency assertion
  if (expect.latencyMs !== undefined) {
    results.push(
      ...evaluateLatencyAssertion(expect.latencyMs, exchange.durationMs),
    );
  }

  // Header assertions
  if (expect.headers !== undefined) {
    for (const [headerName, matcher] of Object.entries(expect.headers)) {
      const actualValue = exchange.response.headers[headerName.toLowerCase()];
      results.push(
        ...evaluateHeaderAssertion(headerName, matcher, actualValue),
      );
    }
  }

  // Body assertions
  if (expect.body !== undefined) {
    results.push(...evaluateBodyAssertions(expect.body, exchange));
  }

  // Stream assertions
  if (expect.stream !== undefined && exchange.stream) {
    if (expect.stream.firstChunkWithinMs !== undefined) {
      const actual = exchange.stream.firstChunkMs ?? 0;
      results.push({
        path: "stream.firstChunkWithinMs",
        matcher: "lte",
        expected: expect.stream.firstChunkWithinMs,
        actual,
        passed: actual <= expect.stream.firstChunkWithinMs,
      });
    }
    if (expect.stream.maxInterChunkMs !== undefined) {
      const actual = exchange.stream.maxInterChunkMs ?? 0;
      results.push({
        path: "stream.maxInterChunkMs",
        matcher: "lte",
        expected: expect.stream.maxInterChunkMs,
        actual,
        passed: actual <= expect.stream.maxInterChunkMs,
      });
    }
    if (expect.stream.minChunks !== undefined) {
      const actual = exchange.stream.totalChunks;
      results.push({
        path: "stream.minChunks",
        matcher: "gte",
        expected: expect.stream.minChunks,
        actual,
        passed: actual >= expect.stream.minChunks,
      });
    }
  }

  return results;
}

function evaluateStatusAssertion(
  expected: number | number[],
  actual: number,
): AssertionResult {
  if (typeof expected === "number") {
    return {
      path: "status",
      matcher: "equals",
      expected,
      actual,
      passed: actual === expected,
    };
  }
  return {
    path: "status",
    matcher: "oneOf",
    expected,
    actual,
    passed: expected.includes(actual),
  };
}

function evaluateLatencyAssertion(
  matcher: LatencyMatcher,
  actual: number,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (matcher.lt !== undefined) {
    results.push({
      path: "latencyMs",
      matcher: "lt",
      expected: matcher.lt,
      actual,
      passed: actual < matcher.lt,
    });
  }
  if (matcher.lte !== undefined) {
    results.push({
      path: "latencyMs",
      matcher: "lte",
      expected: matcher.lte,
      actual,
      passed: actual <= matcher.lte,
    });
  }
  if (matcher.gt !== undefined) {
    results.push({
      path: "latencyMs",
      matcher: "gt",
      expected: matcher.gt,
      actual,
      passed: actual > matcher.gt,
    });
  }
  if (matcher.gte !== undefined) {
    results.push({
      path: "latencyMs",
      matcher: "gte",
      expected: matcher.gte,
      actual,
      passed: actual >= matcher.gte,
    });
  }
  return results;
}

function evaluateHeaderAssertion(
  headerName: string,
  matcher: HeaderMatcher | string,
  actual: string | undefined,
): AssertionResult[] {
  const path = `headers.${headerName}`;
  if (typeof matcher === "string") {
    return [
      {
        path,
        matcher: "equals",
        expected: matcher,
        actual: actual ?? null,
        passed: actual === matcher,
      },
    ];
  }

  const results: AssertionResult[] = [];
  if (matcher.exists !== undefined) {
    results.push({
      path,
      matcher: "exists",
      expected: matcher.exists,
      actual: actual !== undefined,
      passed: (actual !== undefined) === matcher.exists,
    });
  }
  if (matcher.equals !== undefined) {
    results.push({
      path,
      matcher: "equals",
      expected: matcher.equals,
      actual: actual ?? null,
      passed: actual === matcher.equals,
    });
  }
  if (matcher.startsWith !== undefined) {
    results.push({
      path,
      matcher: "startsWith",
      expected: matcher.startsWith,
      actual: actual ?? null,
      passed: actual?.startsWith(matcher.startsWith) ?? false,
    });
  }
  if (matcher.endsWith !== undefined) {
    results.push({
      path,
      matcher: "endsWith",
      expected: matcher.endsWith,
      actual: actual ?? null,
      passed: actual?.endsWith(matcher.endsWith) ?? false,
    });
  }
  if (matcher.contains !== undefined) {
    results.push({
      path,
      matcher: "contains",
      expected: matcher.contains,
      actual: actual ?? null,
      passed: actual?.includes(matcher.contains) ?? false,
    });
  }
  if (matcher.matches !== undefined) {
    results.push(safeRegexTest(path, matcher.matches, actual ?? ""));
  }
  return results;
}

function evaluateBodyAssertions(
  body: BodyExpectation,
  exchange: HttpExecutionResult,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const bodyText = exchange.response.bodyText ?? "";

  // contains
  if (body.contains) {
    for (const needle of body.contains) {
      results.push({
        path: "body.contains",
        matcher: "contains",
        expected: needle,
        actual: bodyText.includes(needle) ? needle : null,
        passed: bodyText.includes(needle),
      });
    }
  }

  // jsonPath assertions
  if (body.jsonPath) {
    let parsed: JsonValue = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // body is not JSON
    }
    for (const assertion of body.jsonPath) {
      results.push(...evaluateJsonPathAssertion(assertion, parsed));
    }
  }

  // not combinator
  if (body.not) {
    if (body.not.jsonPath) {
      let parsed: JsonValue = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // body is not JSON
      }
      for (const assertion of body.not.jsonPath) {
        const innerResults = evaluateJsonPathAssertion(assertion, parsed);
        // Invert: the not block passes when the inner assertion fails
        for (const r of innerResults) {
          const innerPath = r.path.startsWith("body.")
            ? r.path.replace("body.", "body.not.")
            : `body.not.${r.path}`;
          results.push({
            ...r,
            path: innerPath,
            matcher: `not.${r.matcher}`,
            passed: !r.passed,
          });
        }
      }
    }
    if (body.not.contains) {
      for (const needle of body.not.contains) {
        results.push({
          path: "body.not.contains",
          matcher: "not.contains",
          expected: needle,
          actual: bodyText.includes(needle) ? needle : null,
          passed: !bodyText.includes(needle),
        });
      }
    }
  }

  return results;
}

function evaluateJsonPathAssertion(
  assertion: JsonPathAssertion,
  parsed: JsonValue,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const path = `body.jsonPath(${assertion.path})`;
  const extracted = extractJsonPath(parsed, assertion.path);

  if (assertion.exists !== undefined) {
    results.push({
      path,
      matcher: "exists",
      expected: assertion.exists,
      actual: extracted !== undefined,
      passed: (extracted !== undefined) === assertion.exists,
    });
  }

  if (assertion.equals !== undefined) {
    const actual = (extracted ?? null) as JsonValue;
    results.push({
      path,
      matcher: "equals",
      expected: assertion.equals,
      actual,
      passed: JSON.stringify(actual) === JSON.stringify(assertion.equals),
    });
  }

  if (assertion.length !== undefined) {
    const actualLength = Array.isArray(extracted) ? extracted.length : 0;
    if (typeof assertion.length === "number") {
      results.push({
        path,
        matcher: "length",
        expected: assertion.length,
        actual: actualLength,
        passed: actualLength === assertion.length,
      });
    } else {
      if (assertion.length.gte !== undefined) {
        results.push({
          path,
          matcher: "length.gte",
          expected: assertion.length.gte,
          actual: actualLength,
          passed: actualLength >= assertion.length.gte,
        });
      }
      if (assertion.length.lte !== undefined) {
        results.push({
          path,
          matcher: "length.lte",
          expected: assertion.length.lte,
          actual: actualLength,
          passed: actualLength <= assertion.length.lte,
        });
      }
      if (assertion.length.gt !== undefined) {
        results.push({
          path,
          matcher: "length.gt",
          expected: assertion.length.gt,
          actual: actualLength,
          passed: actualLength > assertion.length.gt,
        });
      }
      if (assertion.length.lt !== undefined) {
        results.push({
          path,
          matcher: "length.lt",
          expected: assertion.length.lt,
          actual: actualLength,
          passed: actualLength < assertion.length.lt,
        });
      }
    }
  }

  if (assertion.matches !== undefined) {
    const actual =
      typeof extracted === "string" ? extracted : String(extracted ?? "");
    results.push(safeRegexTest(path, assertion.matches, actual));
  }

  if (assertion.gte !== undefined) {
    const actual = typeof extracted === "number" ? extracted : 0;
    results.push({
      path,
      matcher: "gte",
      expected: assertion.gte,
      actual,
      passed: actual >= assertion.gte,
    });
  }

  if (assertion.lte !== undefined) {
    const actual = typeof extracted === "number" ? extracted : 0;
    results.push({
      path,
      matcher: "lte",
      expected: assertion.lte,
      actual,
      passed: actual <= assertion.lte,
    });
  }

  if (assertion.gt !== undefined) {
    const actual = typeof extracted === "number" ? extracted : 0;
    results.push({
      path,
      matcher: "gt",
      expected: assertion.gt,
      actual,
      passed: actual > assertion.gt,
    });
  }

  if (assertion.lt !== undefined) {
    const actual = typeof extracted === "number" ? extracted : 0;
    results.push({
      path,
      matcher: "lt",
      expected: assertion.lt,
      actual,
      passed: actual < assertion.lt,
    });
  }

  return results;
}

function safeRegexTest(
  path: string,
  pattern: string,
  actual: string,
): AssertionResult {
  try {
    const regex = new RegExp(pattern);
    return {
      path,
      matcher: "matches",
      expected: pattern,
      actual,
      passed: regex.test(actual),
    };
  } catch {
    return {
      path,
      matcher: "matches",
      expected: pattern,
      actual: `<invalid regex: ${pattern}>`,
      passed: false,
    };
  }
}

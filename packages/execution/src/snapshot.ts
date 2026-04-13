import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import type {
  AssertionResult,
  BodyExpectation,
  HttpExecutionResult,
  JsonValue,
} from "@exit-zero-labs/httpi-contracts";
import {
  exitCodes,
  fileExists,
  HttpiError,
} from "@exit-zero-labs/httpi-shared";

/**
 * B3 snapshot / golden-response comparison.
 *
 * - Loads an expected snapshot from a tracked path under `httpi/snapshots/`.
 * - Applies declarative masks (`mask: [{ path: $.requestId }]`) so volatile
 *   fields are excluded from the diff.
 * - Emits a JSON Patch (RFC 6902) as the `actual` field of the structured
 *   assertion result when the comparison fails, so agents and reviewers can
 *   reason about the change structurally instead of eyeballing text diffs.
 */

export interface SnapshotContext {
  projectRoot: string;
  requestFilePath?: string | undefined;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: JsonValue | undefined;
}

export async function evaluateSnapshotAssertion(
  body: BodyExpectation,
  exchange: HttpExecutionResult,
  ctx: SnapshotContext,
): Promise<AssertionResult[]> {
  if (body.kind !== "snapshot" || !body.file) return [];
  const snapshotPath = resolveSnapshotPath(body.file, ctx);
  const bodyText = exchange.response.bodyText ?? "";
  const actualParsed = safeParseJson(bodyText);
  const masks = (body.mask ?? []).map((m) => m.path);
  const actual = applyMask(actualParsed, masks);

  if (!(await fileExists(snapshotPath))) {
    return [
      {
        path: "body.snapshot",
        matcher: "snapshot.missing",
        expected: body.file,
        actual: `no snapshot at ${snapshotPath} — run: httpi snapshot accept <sessionId> --step <id>`,
        passed: false,
      },
    ];
  }

  let expected: unknown;
  try {
    expected = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    return [
      {
        path: "body.snapshot",
        matcher: "snapshot.invalid",
        expected: body.file,
        actual: error instanceof Error ? error.message : "unknown parse error",
        passed: false,
      },
    ];
  }

  const expectedMasked = applyMask(expected, masks);
  const patch = diff(expectedMasked, actual, "");
  if (patch.length === 0) {
    return [
      {
        path: "body.snapshot",
        matcher: "snapshot.match",
        expected: body.file,
        actual: body.file,
        passed: true,
      },
    ];
  }
  return [
    {
      path: "body.snapshot",
      matcher: "snapshot.diff",
      expected: body.file,
      actual: patch as unknown as JsonValue,
      passed: false,
    },
  ];
}

export function resolveSnapshotPath(
  file: string,
  ctx: SnapshotContext,
): string {
  if (isAbsolute(file)) return file;
  if (ctx.requestFilePath) {
    return resolvePath(dirname(ctx.requestFilePath), file);
  }
  return resolvePath(ctx.projectRoot, file);
}

export function applyMask(value: unknown, maskPaths: string[]): unknown {
  if (maskPaths.length === 0) return value;
  // Apply masks depth-first by simple JSONPath-lite (supports $, dot,
  // [index], and [*] wildcard for arrays).
  let result = clone(value);
  for (const p of maskPaths) {
    result = setAtPath(result, parsePath(p), MASKED);
  }
  return result;
}

const MASKED = "<<MASKED>>";

type PathSegment =
  | { kind: "key"; value: string }
  | { kind: "index"; value: number }
  | { kind: "wild" };

function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  if (path.startsWith("$")) i++;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      let key = "";
      while (
        i < path.length &&
        path[i] !== "." &&
        path[i] !== "[" &&
        path[i] !== undefined
      ) {
        key += path[i];
        i++;
      }
      if (key.length > 0) segments.push({ kind: "key", value: key });
      continue;
    }
    if (ch === "[") {
      i++;
      let raw = "";
      while (i < path.length && path[i] !== "]") {
        raw += path[i];
        i++;
      }
      if (path[i] === "]") i++;
      if (raw === "*") segments.push({ kind: "wild" });
      else if (/^\d+$/.test(raw))
        segments.push({ kind: "index", value: Number(raw) });
      else
        segments.push({
          kind: "key",
          value: raw.replace(/^['"]|['"]$/g, ""),
        });
      continue;
    }
    i++;
  }
  return segments;
}

function setAtPath(
  value: unknown,
  segments: PathSegment[],
  replacement: unknown,
): unknown {
  if (segments.length === 0) return replacement;
  const head = segments[0];
  if (!head) return value;
  const rest = segments.slice(1);
  switch (head.kind) {
    case "wild":
      if (Array.isArray(value))
        return value.map((v) => setAtPath(v, rest, replacement));
      return value;
    case "index": {
      if (!Array.isArray(value)) return value;
      const copy = value.slice();
      if (head.value >= 0 && head.value < copy.length) {
        copy[head.value] = setAtPath(copy[head.value], rest, replacement);
      }
      return copy;
    }
    case "key": {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return value;
      const copy = { ...(value as Record<string, unknown>) };
      if (head.value in copy) {
        copy[head.value] = setAtPath(copy[head.value], rest, replacement);
      }
      return copy;
    }
  }
}

function clone(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = clone(val);
  }
  return out;
}

function diff(expected: unknown, actual: unknown, base: string): JsonPatchOp[] {
  if (equal(expected, actual)) return [];

  const expectedIsObject =
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected);
  const actualIsObject =
    actual !== null && typeof actual === "object" && !Array.isArray(actual);

  if (expectedIsObject && actualIsObject) {
    const ops: JsonPatchOp[] = [];
    const ek = Object.keys(expected as Record<string, unknown>);
    const ak = Object.keys(actual as Record<string, unknown>);
    const all = new Set([...ek, ...ak]);
    for (const key of all) {
      const ev = (expected as Record<string, unknown>)[key];
      const av = (actual as Record<string, unknown>)[key];
      const segment = `${base}/${escapePointer(key)}`;
      if (!(key in (actual as Record<string, unknown>))) {
        ops.push({ op: "remove", path: segment });
      } else if (!(key in (expected as Record<string, unknown>))) {
        ops.push({ op: "add", path: segment, value: av as JsonValue });
      } else {
        ops.push(...diff(ev, av, segment));
      }
    }
    return ops;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const ops: JsonPatchOp[] = [];
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i++) {
      const segment = `${base}/${i}`;
      if (i >= actual.length) {
        ops.push({ op: "remove", path: segment });
      } else if (i >= expected.length) {
        ops.push({ op: "add", path: segment, value: actual[i] as JsonValue });
      } else {
        ops.push(...diff(expected[i], actual[i], segment));
      }
    }
    return ops;
  }

  return [
    {
      op: "replace",
      path: base === "" ? "" : base,
      value: actual as JsonValue,
    },
  ];
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function acceptSnapshot(
  snapshotPath: string,
  value: unknown,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!(await fileExists(snapshotPath))) {
    throw new HttpiError(
      "SNAPSHOT_WRITE_FAILED",
      `Failed to write snapshot at ${snapshotPath}.`,
      { exitCode: exitCodes.internalError },
    );
  }
}

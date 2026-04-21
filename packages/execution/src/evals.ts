/**
 * WS3 eval loop.
 *
 * Evals are pure-data YAML at runmark/evals/<id>.eval.yaml that pair a
 * target run (or request) with a dataset. Running an eval fans out one
 * session per dataset row with row-scoped variable overrides, then writes an
 * aggregated summary at runmark/artifacts/evals/<evalId>/<ts>/summary.{json,md}.
 *
 * Scope for this slice:
 * - dataset kinds: jsonl and csv
 * - target kinds: run and request
 * - per-row pass/fail = session completed state (richer expect DSL is a
 *   follow-up; each row already runs the request's own expect assertions).
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  EnrichedDiagnostic,
  ExecutionResult,
  FlatVariableMap,
  FlatVariableValue,
} from "@exit-zero-labs/runmark-contracts";
import { findProjectRoot } from "@exit-zero-labs/runmark-definitions";
import {
  exitCodes,
  resolveFromRoot,
  RunmarkError,
  trackedDirectoryName,
} from "@exit-zero-labs/runmark-shared";
import type { EngineOptions } from "./types.js";

interface EvalDefinition {
  kind: "eval";
  schemaVersion: 1;
  title?: string;
  target: { run: string } | { request: string };
  env?: string;
  dataset: { kind: "jsonl" | "csv"; path: string };
  concurrency?: number;
}

export interface EvalListEntry {
  id: string;
  title?: string;
  filePath: string;
  targetKind: "run" | "request";
  targetId: string;
  datasetPath: string;
}

export interface EvalRowOutcome {
  rowIndex: number;
  input: FlatVariableMap;
  sessionId: string;
  state: string;
  durationMs: number;
  errorMessage?: string;
}

export interface EvalRunResult {
  evalId: string;
  runStartedAt: string;
  runFinishedAt: string;
  totals: {
    rows: number;
    passed: number;
    failed: number;
  };
  rows: EvalRowOutcome[];
  artifactsDir: string;
  diagnostics: EnrichedDiagnostic[];
}

export async function listEvalDefinitions(
  options: EngineOptions = {},
): Promise<{ rootDir: string; evals: EvalListEntry[] }> {
  const rootDir = await findProjectRoot(options);
  const evalsDir = resolveFromRoot(rootDir, trackedDirectoryName, "evals");
  const entries = await safeReaddir(evalsDir);
  const evals: EvalListEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".eval.yaml")) continue;
    const filePath = resolve(evalsDir, entry);
    const parsed = await readEvalFile(filePath);
    const id = entry.slice(0, -".eval.yaml".length);
    const target = parsed.target;
    const targetKind: "run" | "request" = "run" in target ? "run" : "request";
    const targetId = "run" in target ? target.run : target.request;
    evals.push({
      id,
      ...(parsed.title ? { title: parsed.title } : {}),
      filePath,
      targetKind,
      targetId,
      datasetPath: parsed.dataset.path,
    });
  }
  evals.sort((a, b) => a.id.localeCompare(b.id));
  return { rootDir, evals };
}

export async function runEval(
  evalId: string,
  options: EngineOptions = {},
): Promise<EvalRunResult> {
  const rootDir = await findProjectRoot(options);
  const filePath = resolveFromRoot(
    rootDir,
    trackedDirectoryName,
    "evals",
    `${evalId}.eval.yaml`,
  );
  const definition = await readEvalFile(filePath);
  const rows = await readDataset(rootDir, definition.dataset);
  const concurrency = Math.max(1, definition.concurrency ?? 1);
  const runStartedAt = new Date().toISOString();
  const target = definition.target;
  const envId = definition.env;

  const outcomes: EvalRowOutcome[] = new Array(rows.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const input = rows[index] as FlatVariableMap;
      const started = Date.now();
      try {
        const execution = await executeRow(target, envId, input, options);
        outcomes[index] = {
          rowIndex: index,
          input,
          sessionId: execution.session.sessionId,
          state: execution.session.state,
          durationMs: Date.now() - started,
          ...(execution.session.failureReason
            ? { errorMessage: execution.session.failureReason }
            : {}),
        };
      } catch (error) {
        outcomes[index] = {
          rowIndex: index,
          input,
          sessionId: "",
          state: "failed",
          durationMs: Date.now() - started,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const runFinishedAt = new Date().toISOString();
  const totals = {
    rows: outcomes.length,
    passed: outcomes.filter((row) => row.state === "completed").length,
    failed: outcomes.filter((row) => row.state !== "completed").length,
  };

  const ts = runStartedAt.replace(/[:.]/g, "-");
  const artifactsDir = resolveFromRoot(
    rootDir,
    trackedDirectoryName,
    "artifacts",
    "evals",
    evalId,
    ts,
  );
  await mkdir(artifactsDir, { recursive: true });
  const result: EvalRunResult = {
    evalId,
    runStartedAt,
    runFinishedAt,
    totals,
    rows: outcomes,
    artifactsDir,
    diagnostics: [],
  };
  await writeFile(
    resolve(artifactsDir, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(artifactsDir, "summary.md"),
    renderEvalSummaryMarkdown(result),
    "utf8",
  );
  return result;
}

async function executeRow(
  target: EvalDefinition["target"],
  envId: string | undefined,
  overrides: FlatVariableMap,
  options: EngineOptions,
): Promise<ExecutionResult> {
  // Lazy import so evals.ts can be pulled in from index.ts without creating
  // a cycle at module load time.
  const { runRun, runRequest } = await import("./index.js");
  const common = {
    ...(envId ? { envId } : {}),
    overrides,
    ...options,
  };
  if ("run" in target) {
    return runRun(target.run, common);
  }
  return runRequest(target.request, common);
}

async function readEvalFile(filePath: string): Promise<EvalDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunmarkError(
        "EVAL_NOT_FOUND",
        `Eval definition not found at ${filePath}. Create one with runmark new eval <id>.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new RunmarkError(
      "EVAL_YAML_INVALID",
      `Eval ${filePath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RunmarkError(
      "EVAL_SHAPE_INVALID",
      `Eval ${filePath} must be a YAML mapping.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== "eval") {
    throw new RunmarkError(
      "EVAL_KIND_INVALID",
      `Eval ${filePath} must set "kind: eval".`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (record.schemaVersion !== 1) {
    throw new RunmarkError(
      "EVAL_SCHEMA_VERSION_UNSUPPORTED",
      `Eval ${filePath} must set "schemaVersion: 1".`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const target = record.target as EvalDefinition["target"] | undefined;
  if (!target || (!("run" in target) && !("request" in target))) {
    throw new RunmarkError(
      "EVAL_TARGET_REQUIRED",
      `Eval ${filePath} must declare target.run or target.request.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const dataset = record.dataset as EvalDefinition["dataset"] | undefined;
  if (!dataset || (dataset.kind !== "jsonl" && dataset.kind !== "csv")) {
    throw new RunmarkError(
      "EVAL_DATASET_REQUIRED",
      `Eval ${filePath} must declare dataset.kind as jsonl or csv with a relative path.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (typeof dataset.path !== "string" || dataset.path.length === 0) {
    throw new RunmarkError(
      "EVAL_DATASET_PATH_REQUIRED",
      `Eval ${filePath} must declare dataset.path.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  return {
    kind: "eval",
    schemaVersion: 1,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    target,
    ...(typeof record.env === "string" ? { env: record.env } : {}),
    dataset,
    ...(typeof record.concurrency === "number"
      ? { concurrency: record.concurrency }
      : {}),
  };
}

async function readDataset(
  rootDir: string,
  dataset: EvalDefinition["dataset"],
): Promise<FlatVariableMap[]> {
  const trackedRoot = resolveFromRoot(rootDir, trackedDirectoryName);
  const datasetPath = resolve(trackedRoot, dataset.path);
  if (!datasetPath.startsWith(trackedRoot)) {
    throw new RunmarkError(
      "EVAL_DATASET_OUTSIDE_PROJECT",
      `Dataset ${dataset.path} must stay inside runmark/.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const raw = (await readFile(datasetPath, "utf8")).replace(/^\uFEFF/, "");
  if (dataset.kind === "jsonl") {
    const rows = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(
              "row must be a JSON object (received array or non-object).",
            );
          }
          return coerceFlatMap(parsed as Record<string, unknown>);
        } catch (error) {
          throw new RunmarkError(
            "EVAL_DATASET_ROW_INVALID",
            `Dataset ${dataset.path} row ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}.`,
            { exitCode: exitCodes.validationFailure },
          );
        }
      });
    if (rows.length === 0) {
      throw new RunmarkError(
        "EVAL_DATASET_EMPTY",
        `Dataset ${dataset.path} contains no rows.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
    return rows;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new RunmarkError(
      "EVAL_DATASET_EMPTY",
      `Dataset ${dataset.path} must contain a header row plus at least one data row.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  const header = splitCsvLine(lines[0] ?? "");
  return lines.slice(1).map((line, index) => {
    const values = splitCsvLine(line);
    const row: FlatVariableMap = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i] ?? "";
      const raw = values[i] ?? "";
      row[key] = coerceCsvValue(raw);
    }
    if (Object.keys(row).length === 0) {
      throw new RunmarkError(
        "EVAL_DATASET_ROW_INVALID",
        `Dataset ${dataset.path} row ${index + 2} is empty.`,
        { exitCode: exitCodes.validationFailure },
      );
    }
    return row;
  });
}

function coerceFlatMap(record: Record<string, unknown>): FlatVariableMap {
  const output: FlatVariableMap = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = value as FlatVariableValue;
    } else {
      throw new Error(`value for "${key}" must be a string, number, boolean, or null`);
    }
  }
  return output;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  const quotedMask: boolean[] = [];
  let current = "";
  let cellWasQuoted = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? "";
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
      cellWasQuoted = true;
    } else if (char === ",") {
      cells.push(current);
      quotedMask.push(cellWasQuoted);
      current = "";
      cellWasQuoted = false;
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    throw new RunmarkError(
      "EVAL_DATASET_ROW_INVALID",
      `CSV row has an unclosed quote: ${line}`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  cells.push(current);
  quotedMask.push(cellWasQuoted);
  return cells.map((cell, index) =>
    quotedMask[index] ? cell : cell.trim(),
  );
}

function coerceCsvValue(raw: string): FlatVariableValue {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function renderEvalSummaryMarkdown(result: EvalRunResult): string {
  const lines: string[] = [];
  const passRate =
    result.totals.rows > 0
      ? ((result.totals.passed / result.totals.rows) * 100).toFixed(1)
      : "0.0";
  lines.push(`# Eval \`${result.evalId}\``);
  lines.push("");
  lines.push(`- Started: ${result.runStartedAt}`);
  lines.push(`- Finished: ${result.runFinishedAt}`);
  lines.push(
    `- Rows: ${result.totals.passed}/${result.totals.rows} passed (${passRate}%)`,
  );
  lines.push("");
  if (result.rows.length > 0) {
    lines.push("| # | State | Session | Duration | Error |");
    lines.push("| ---: | --- | --- | ---: | --- |");
    for (const row of result.rows) {
      lines.push(
        `| ${row.rowIndex} | ${row.state} | ${row.sessionId || "—"} | ${row.durationMs}ms | ${row.errorMessage ?? ""} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// end

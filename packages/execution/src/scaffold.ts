/**
 * WS2 "new" scaffolders.
 *
 * Produces pure-YAML definition files whose paths are derived from the caller
 * id (dotted ids map to nested directories). Every template includes the YAML
 * schema hint so editors pick up validation immediately. Scaffolders refuse to
 * overwrite existing files so there's no risk of silently clobbering edits.
 */
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertPathWithin,
  ensureDir,
  exitCodes,
  resolveFromRoot,
  RunmarkError,
  trackedDirectoryName,
  writeUtf8File,
} from "@exit-zero-labs/runmark-shared";
import { findProjectRoot } from "@exit-zero-labs/runmark-definitions";
import type { EngineOptions } from "./types.js";

const schemaBaseUrl =
  "https://raw.githubusercontent.com/exit-zero-labs/runmark/main/packages/contracts/schemas";

export type ScaffoldKind = "request" | "run" | "env" | "block" | "eval";

export interface ScaffoldOptions extends EngineOptions {
  kind: ScaffoldKind;
  id: string;
  /** Only used when kind === "block". Must be "headers" or "auth". */
  blockKind?: string;
}

export interface ScaffoldResult {
  kind: ScaffoldKind;
  id: string;
  filePath: string;
}

export async function scaffoldDefinition(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const rootDir = await findProjectRoot(options);
  const id = validateId(options.id);
  switch (options.kind) {
    case "request":
      return writeDefinition(
        rootDir,
        "request",
        id,
        ["requests", `${idToRelativePath(id)}.request.yaml`],
        renderRequestTemplate(id),
      );
    case "run":
      return writeDefinition(
        rootDir,
        "run",
        id,
        ["runs", `${idToRelativePath(id)}.run.yaml`],
        renderRunTemplate(id),
      );
    case "env":
      return writeDefinition(
        rootDir,
        "env",
        id,
        ["env", `${idToRelativePath(id)}.env.yaml`],
        renderEnvTemplate(id),
      );
    case "block": {
      const blockKind = options.blockKind;
      if (blockKind !== "headers" && blockKind !== "auth") {
        throw new RunmarkError(
          "NEW_BLOCK_KIND_REQUIRED",
          'runmark new block expects a --block-kind of "headers" or "auth".',
          { exitCode: exitCodes.validationFailure },
        );
      }
      return writeDefinition(
        rootDir,
        "block",
        id,
        [
          "blocks",
          blockKind,
          `${idToRelativePath(id)}.${blockKind === "auth" ? "auth" : "headers"}.yaml`,
        ],
        blockKind === "headers"
          ? renderHeadersBlockTemplate(id)
          : renderAuthBlockTemplate(id),
      );
    }
    case "eval":
      return writeDefinition(
        rootDir,
        "eval",
        id,
        ["evals", `${idToRelativePath(id)}.eval.yaml`],
        renderEvalTemplate(id),
      );
  }
}

function validateId(id: string): string {
  if (!id || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(id)) {
    throw new RunmarkError(
      "NEW_ID_INVALID",
      `"${id}" is not a valid runmark id. Use letters, digits, dots, dashes, or underscores (e.g. checkout.ping).`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  return id;
}

function idToRelativePath(id: string): string {
  // Runmark derives definition ids from file paths by stripping the type suffix
  // and converting to POSIX, so we keep scaffolded files flat: the full id is
  // the filename stem, preserving dots/dashes verbatim.
  return id;
}

async function writeDefinition(
  rootDir: string,
  kind: ScaffoldKind,
  id: string,
  segments: string[],
  content: string,
): Promise<ScaffoldResult> {
  const trackedRoot = resolveFromRoot(rootDir, trackedDirectoryName);
  const filePath = resolveFromRoot(trackedRoot, ...segments);
  assertPathWithin(trackedRoot, filePath, {
    code: "NEW_PATH_OUTSIDE_PROJECT",
    message: `Scaffolded ${kind} would be written outside runmark/: ${filePath}.`,
    exitCode: exitCodes.validationFailure,
  });
  if (await fileExists(filePath)) {
    throw new RunmarkError(
      "NEW_DEFINITION_EXISTS",
      `Cannot scaffold ${kind} ${id}: ${filePath} already exists. Edit the file directly or pick a new id.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  await ensureDir(dirname(filePath));
  await writeUtf8File(filePath, content);
  return { kind, id, filePath };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function schemaComment(schemaFileName: string): string {
  return `# yaml-language-server: $schema=${schemaBaseUrl}/${schemaFileName}`;
}

function renderRequestTemplate(id: string): string {
  return [
    schemaComment("request.schema.json"),
    "kind: request",
    `title: ${humanizeId(id)}`,
    "method: GET",
    'url: "{{baseUrl}}/"',
    "expect:",
    "  status: 200",
    "",
  ].join("\n");
}

function renderRunTemplate(id: string): string {
  return [
    schemaComment("run.schema.json"),
    "kind: run",
    `title: ${humanizeId(id)}`,
    "env: dev",
    "steps:",
    "  - kind: request",
    "    id: step-1",
    "    uses: TODO",
    "",
  ].join("\n");
}

function renderEnvTemplate(id: string): string {
  return [
    schemaComment("env.schema.json"),
    "schemaVersion: 1",
    `title: ${humanizeId(id)}`,
    "values:",
    '  baseUrl: "http://127.0.0.1:4318"',
    "",
  ].join("\n");
}

function renderHeadersBlockTemplate(id: string): string {
  return [
    schemaComment("header-block.schema.json"),
    `title: ${humanizeId(id)}`,
    "headers:",
    '  accept: "application/json"',
    "",
  ].join("\n");
}

function renderAuthBlockTemplate(id: string): string {
  return [
    schemaComment("auth-block.schema.json"),
    `title: ${humanizeId(id)}`,
    "auth:",
    "  scheme: bearer",
    "  token: '{{secrets.apiToken}}'",
    "",
  ].join("\n");
}

function renderEvalTemplate(id: string): string {
  return [
    schemaComment("eval.schema.json"),
    "kind: eval",
    "schemaVersion: 1",
    `title: ${humanizeId(id)}`,
    "target:",
    "  run: TODO",
    "env: dev",
    "dataset:",
    "  kind: jsonl",
    `  path: datasets/${id}.jsonl`,
    "concurrency: 1",
    "",
  ].join("\n");
}

function humanizeId(id: string): string {
  return id
    .split(/[._-]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

import { lstat, readFile, realpath } from "node:fs/promises";
import type {
  Diagnostic,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import { toDisplayDiagnosticFile } from "@exit-zero-labs/httpi-contracts";
import {
  assertPathWithin,
  exitCodes,
  HttpiError,
  hashProcessEnvValue,
  sha256Hex,
} from "@exit-zero-labs/httpi-shared";
import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type ParsedNode,
} from "yaml";
import { isMissingPathError } from "./runtime-errors.js";

export async function detectDefinitionDrift(
  projectRoot: string,
  session: SessionRecord,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const resolvedProjectRoot = await realpath(projectRoot);
  const definitionFilePaths = Object.keys(session.compiled.definitionHashes).sort(
    (left, right) => left.localeCompare(right),
  );

  for (const [filePath, expectedHash] of Object.entries(
    session.compiled.definitionHashes,
  )) {
    const displayFilePath = toDisplayDiagnosticFile(filePath);
    const stats = await lstat(filePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    });
    if (!stats) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_DELETED",
        message: `Tracked file ${displayFilePath} no longer exists.`,
        hint: "Start a fresh run or restore the tracked file before resuming this session.",
        filePath,
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${displayFilePath} must not resolve through a symlink.`,
        hint: "Replace the symlink with a real tracked file before resuming this session.",
        filePath,
      });
      continue;
    }
    if (!stats.isFile()) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${displayFilePath} must be a file.`,
        hint: "Restore the tracked definition as a regular file before resuming this session.",
        filePath,
      });
      continue;
    }

    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(filePath);
      assertPathWithin(resolvedProjectRoot, resolvedFilePath, {
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${displayFilePath} must stay within the project root.`,
        exitCode: exitCodes.validationFailure,
      });
    } catch (error) {
      if (
        error instanceof HttpiError &&
        error.code === "DEFINITION_PATH_INVALID"
      ) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message,
          hint: "Restore the tracked definition to a regular file inside the project root before resuming this session.",
          filePath,
        });
        continue;
      }

      throw error;
    }

    const currentHash = sha256Hex(await readFile(resolvedFilePath));
    if (currentHash !== expectedHash) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_DRIFT",
        message: `Tracked file ${displayFilePath} changed after session creation.`,
        hint: "Start a fresh run or revert the tracked file before resuming this session.",
        filePath,
      });
    }
  }

  for (const [environmentName, expectedHash] of Object.entries(
    session.compiled.processEnvHashes ?? {},
  )) {
    if (hashProcessEnvValue(processEnv[environmentName]) === expectedHash) {
      continue;
    }

    const locatedDiagnostic = await findProcessEnvReferenceDiagnostic(
      definitionFilePaths,
      environmentName,
    );
    diagnostics.push(
      locatedDiagnostic ?? {
        level: "error",
        code: "PROCESS_ENV_DRIFT",
        message: `Environment variable ${environmentName} changed after session creation.`,
        hint: "Run the workflow again with the current environment instead of resuming a session created under different $ENV values.",
        filePath: `$ENV:${environmentName}`,
        path: environmentName,
      },
    );
  }

  return diagnostics;
}

async function findProcessEnvReferenceDiagnostic(
  filePaths: string[],
  environmentName: string,
): Promise<Diagnostic | undefined> {
  const searchToken = `$ENV:${environmentName}`;

  for (const filePath of filePaths) {
    const fileContent = await readFile(filePath, "utf8").catch(() => undefined);
    if (!fileContent) {
      continue;
    }

    const position = findYamlTokenPosition(fileContent, searchToken);
    if (!position) {
      continue;
    }

    return {
      level: "error",
      code: "PROCESS_ENV_DRIFT",
      message: `Environment variable ${environmentName} changed after session creation.`,
      hint: "Run the workflow again with the current environment instead of resuming a session created under different $ENV values.",
      filePath,
      line: position.line,
      column: position.column,
    };
  }

  return undefined;
}

function findYamlTokenPosition(
  rawContent: string,
  searchToken: string,
): {
  line: number;
  column: number;
} | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(rawContent, {
    lineCounter,
    prettyErrors: false,
  });

  const tokenOffset =
    findTokenOffset(document.contents, rawContent, searchToken) ??
    rawContent.indexOf(searchToken);
  if (tokenOffset === -1 || tokenOffset === undefined) {
    return undefined;
  }

  return positionFromOffset(lineCounter, tokenOffset);
}

function findTokenOffset(
  node: ParsedNode | null | undefined,
  rawContent: string,
  searchToken: string,
): number | undefined {
  if (!node) {
    return undefined;
  }

  const scalarOffset = findScalarTokenOffset(node, rawContent, searchToken);
  if (scalarOffset !== undefined) {
    return scalarOffset;
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      const keyOffset = findTokenOffset(
        pair.key as ParsedNode | null | undefined,
        rawContent,
        searchToken,
      );
      if (keyOffset !== undefined) {
        return keyOffset;
      }

      const valueOffset = findTokenOffset(
        pair.value as ParsedNode | null | undefined,
        rawContent,
        searchToken,
      );
      if (valueOffset !== undefined) {
        return valueOffset;
      }
    }
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      const itemOffset = findTokenOffset(
        item as ParsedNode | null | undefined,
        rawContent,
        searchToken,
      );
      if (itemOffset !== undefined) {
        return itemOffset;
      }
    }
  }

  return undefined;
}

function findScalarTokenOffset(
  node: Node,
  rawContent: string,
  searchToken: string,
): number | undefined {
  if (!isScalar(node) || typeof node.value !== "string") {
    return undefined;
  }

  if (!node.value.includes(searchToken)) {
    return undefined;
  }

  const startOffset = getNodeStartOffset(node);
  const endOffset = getNodeEndOffset(node);
  if (startOffset === undefined || endOffset === undefined) {
    return undefined;
  }

  const scalarSource = rawContent.slice(startOffset, endOffset);
  const relativeTokenOffset = scalarSource.indexOf(searchToken);
  return relativeTokenOffset === -1
    ? startOffset
    : startOffset + relativeTokenOffset;
}

function getNodeStartOffset(node: Node): number | undefined {
  return typeof node.range?.[0] === "number" ? node.range[0] : undefined;
}

function getNodeEndOffset(node: Node): number | undefined {
  for (const offset of [node.range?.[2], node.range?.[1], node.range?.[0]]) {
    if (typeof offset === "number") {
      return offset;
    }
  }

  return undefined;
}

function positionFromOffset(
  lineCounter: LineCounter,
  offset: number,
): {
  line: number;
  column: number;
} {
  const position = lineCounter.linePos(offset);
  return {
    line: position?.line ?? 1,
    column: position?.col ?? 1,
  };
}

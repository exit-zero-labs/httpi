import { lstat, readFile, realpath } from "node:fs/promises";
import type {
  Diagnostic,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  assertPathWithin,
  exitCodes,
  HttpiError,
  hashProcessEnvValue,
  sha256Hex,
} from "@exit-zero-labs/httpi-shared";
import { isMissingPathError } from "./runtime-errors.js";

export async function detectDefinitionDrift(
  projectRoot: string,
  session: SessionRecord,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const resolvedProjectRoot = await realpath(projectRoot);

  for (const [filePath, expectedHash] of Object.entries(
    session.compiled.definitionHashes,
  )) {
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
        message: `Tracked file ${filePath} no longer exists.`,
        filePath,
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${filePath} must not resolve through a symlink.`,
        filePath,
      });
      continue;
    }
    if (!stats.isFile()) {
      diagnostics.push({
        level: "error",
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${filePath} must be a file.`,
        filePath,
      });
      continue;
    }

    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(filePath);
      assertPathWithin(resolvedProjectRoot, resolvedFilePath, {
        code: "DEFINITION_PATH_INVALID",
        message: `Tracked file ${filePath} must stay within the project root.`,
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
        message: `Tracked file ${filePath} changed after session creation.`,
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

    diagnostics.push({
      level: "error",
      code: "PROCESS_ENV_DRIFT",
      message: `Environment variable ${environmentName} changed after session creation.`,
      path: environmentName,
    });
  }

  return diagnostics;
}

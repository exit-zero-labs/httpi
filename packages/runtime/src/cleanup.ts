import { lstat, realpath, rm } from "node:fs/promises";
import { assertPathWithin, exitCodes, RunmarkError } from "@exit-zero-labs/runmark-shared";
import {
  assertValidSessionId,
  ensureRuntimePaths,
  getSessionRuntimePaths,
} from "./runtime-paths.js";

export async function removeSessionRuntimeState(
  projectRoot: string,
  sessionId: string,
): Promise<string[]> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  const removedPaths: string[] = [];

  for (const candidatePath of [
    sessionPaths.secretStatePath,
    sessionPaths.sessionPath,
    sessionPaths.lockFilePath,
    sessionPaths.cancelMarkerPath,
    sessionPaths.artifactRoot,
  ]) {
    if (await removeProjectOwnedPathIfExists(projectRoot, candidatePath)) {
      removedPaths.push(candidatePath);
    }
  }

  return removedPaths;
}

export async function removeRuntimeReports(
  projectRoot: string,
): Promise<boolean> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  return removeProjectOwnedPathIfExists(projectRoot, runtimePaths.reportsDir);
}

export async function removeRuntimeSecrets(
  projectRoot: string,
): Promise<boolean> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  return removeProjectOwnedPathIfExists(projectRoot, runtimePaths.secretsPath);
}

async function removeProjectOwnedPathIfExists(
  projectRoot: string,
  targetPath: string,
): Promise<boolean> {
  const stats = await lstat(targetPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    throw new RunmarkError(
      "RUNTIME_PATH_INVALID",
      `Runtime cleanup target ${targetPath} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedTargetPath = await realpath(targetPath);
  assertPathWithin(resolvedProjectRoot, resolvedTargetPath, {
    code: "RUNTIME_PATH_INVALID",
    message: `Runtime cleanup target ${targetPath} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });

  await rm(targetPath, {
    force: true,
    recursive: stats.isDirectory(),
  });
  return true;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

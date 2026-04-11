import { chmod, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPathWithin,
  ensureDir,
  exitCodes,
  HttpiError,
  resolveFromRoot,
  runtimeDirectoryName,
} from "@exit-zero-labs/httpi-shared";
import { isMissingPathError } from "./runtime-errors.js";

export interface RuntimePaths {
  rootDir: string;
  runtimeDir: string;
  sessionsDir: string;
  responsesDir: string;
  secretsPath: string;
}

export interface SessionRuntimePaths {
  sessionPath: string;
  lockFilePath: string;
  artifactRoot: string;
  manifestPath: string;
  eventLogPath: string;
}

export const runtimeDirectoryMode = 0o700;
export const runtimeFileMode = 0o600;

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function ensureRuntimePaths(
  projectRoot: string,
): Promise<RuntimePaths> {
  const runtimeDir = resolveFromRoot(projectRoot, runtimeDirectoryName);
  const sessionsDir = resolveFromRoot(runtimeDir, "sessions");
  const responsesDir = resolveFromRoot(runtimeDir, "responses");
  const secretsPath = resolveFromRoot(runtimeDir, "secrets.yaml");

  await ensureProjectOwnedDirectory(
    projectRoot,
    runtimeDir,
    "The local .httpi runtime directory",
  );
  await ensureProjectOwnedDirectory(
    projectRoot,
    sessionsDir,
    "The local .httpi/sessions directory",
  );
  await ensureProjectOwnedDirectory(
    projectRoot,
    responsesDir,
    "The local .httpi/responses directory",
  );
  await Promise.all([
    chmod(runtimeDir, runtimeDirectoryMode),
    chmod(sessionsDir, runtimeDirectoryMode),
    chmod(responsesDir, runtimeDirectoryMode),
  ]);

  return {
    rootDir: resolve(projectRoot),
    runtimeDir,
    sessionsDir,
    responsesDir,
    secretsPath,
  };
}

export async function ensureProjectOwnedDirectory(
  projectRoot: string,
  directoryPath: string,
  message: string,
): Promise<void> {
  await ensureDir(directoryPath, runtimeDirectoryMode);

  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "RUNTIME_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (!stats.isDirectory()) {
    throw new HttpiError(
      "RUNTIME_PATH_INVALID",
      `${message} must be a directory.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedDirectoryPath = await realpath(directoryPath);
  assertPathWithin(resolvedProjectRoot, resolvedDirectoryPath, {
    code: "RUNTIME_PATH_INVALID",
    message: `${message} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });
}

export async function assertProjectOwnedFileIfExists(
  projectRoot: string,
  filePath: string,
  message: string,
): Promise<void> {
  const stats = await lstat(filePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return;
  }

  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "RUNTIME_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (!stats.isFile()) {
    throw new HttpiError("RUNTIME_PATH_INVALID", `${message} must be a file.`, {
      exitCode: exitCodes.validationFailure,
    });
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedFilePath = await realpath(filePath);
  assertPathWithin(resolvedProjectRoot, resolvedFilePath, {
    code: "RUNTIME_PATH_INVALID",
    message: `${message} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });
}

export function assertValidSessionId(sessionId: string): void {
  if (sessionIdPattern.test(sessionId)) {
    return;
  }

  throw new HttpiError(
    "SESSION_ID_INVALID",
    `Session ID ${sessionId} is invalid.`,
    { exitCode: exitCodes.validationFailure },
  );
}

export function getSessionRuntimePaths(
  runtimePaths: RuntimePaths,
  sessionId: string,
): SessionRuntimePaths {
  const artifactRoot = resolveFromRoot(runtimePaths.responsesDir, sessionId);
  return {
    sessionPath: resolveFromRoot(runtimePaths.sessionsDir, `${sessionId}.json`),
    lockFilePath: resolveFromRoot(
      runtimePaths.sessionsDir,
      `${sessionId}.lock`,
    ),
    artifactRoot,
    manifestPath: resolveFromRoot(artifactRoot, "manifest.json"),
    eventLogPath: resolveFromRoot(artifactRoot, "events.jsonl"),
  };
}

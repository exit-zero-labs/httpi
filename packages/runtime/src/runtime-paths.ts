/**
 * Runtime path helpers for `httpi/artifacts/`.
 *
 * The runtime package treats every path as security-sensitive: directories must
 * stay within the project root, must not traverse symlinks, and are created
 * with restrictive permissions where the platform supports them.
 */
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

/** Canonical absolute locations for the runtime directory tree. */
export interface RuntimePaths {
  rootDir: string;
  runtimeDir: string;
  sessionsDir: string;
  historyDir: string;
  secretsPath: string;
}

/** Derived paths for one session's state, lock, and artifact files. */
export interface SessionRuntimePaths {
  sessionPath: string;
  lockFilePath: string;
  artifactRoot: string;
  manifestPath: string;
  eventLogPath: string;
}

/** Owner-only directory mode used for runtime directories when possible. */
export const runtimeDirectoryMode = 0o700;
/** Owner-only file mode used for runtime files when possible. */
export const runtimeFileMode = 0o600;

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ensure the `httpi/artifacts/` runtime tree exists and stays inside the project root. */
export async function ensureRuntimePaths(
  projectRoot: string,
): Promise<RuntimePaths> {
  const runtimeDir = resolveFromRoot(projectRoot, runtimeDirectoryName);
  const sessionsDir = resolveFromRoot(runtimeDir, "sessions");
  const historyDir = resolveFromRoot(runtimeDir, "history");
  const secretsPath = resolveFromRoot(runtimeDir, "secrets.yaml");

  await ensureProjectOwnedDirectory(
    projectRoot,
    runtimeDir,
    "The local httpi/artifacts runtime directory",
  );
  await ensureProjectOwnedDirectory(
    projectRoot,
    sessionsDir,
    "The local httpi/artifacts/sessions directory",
  );
  await ensureProjectOwnedDirectory(
    projectRoot,
    historyDir,
    "The local httpi/artifacts/history directory",
  );
  await Promise.all([
    chmod(runtimeDir, runtimeDirectoryMode),
    chmod(sessionsDir, runtimeDirectoryMode),
    chmod(historyDir, runtimeDirectoryMode),
  ]);

  return {
    rootDir: resolve(projectRoot),
    runtimeDir,
    sessionsDir,
    historyDir,
    secretsPath,
  };
}

/** Create or validate a runtime-owned directory with path-ownership checks. */
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

/** Reject existing files that escape the project root or resolve through symlinks. */
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

/** Session IDs become file names, so they must stay within a conservative charset. */
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

/** Resolve all runtime-owned paths for one persisted session. */
export function getSessionRuntimePaths(
  runtimePaths: RuntimePaths,
  sessionId: string,
): SessionRuntimePaths {
  const artifactRoot = resolveFromRoot(runtimePaths.historyDir, sessionId);
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

import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertPathWithin,
  exitCodes,
  fileExists,
  HttpiError,
  resolveFromRoot,
  trackedDirectoryName,
} from "@exit-zero-labs/httpi-shared";

export interface FindProjectRootOptions {
  cwd?: string | undefined;
  projectRoot?: string | undefined;
}

export async function findProjectRoot(
  options: FindProjectRootOptions = {},
): Promise<string> {
  if (options.projectRoot) {
    const resolvedProjectRoot = resolve(options.projectRoot);
    const configPath = resolveFromRoot(
      resolvedProjectRoot,
      trackedDirectoryName,
      "config.yaml",
    );
    if (!(await fileExists(configPath))) {
      throw new HttpiError(
        "PROJECT_NOT_FOUND",
        `No ${trackedDirectoryName}/config.yaml found under ${resolvedProjectRoot}.`,
        {
          exitCode: exitCodes.validationFailure,
        },
      );
    }

    await assertTrackedDirectoryWithinProjectRoot(resolvedProjectRoot);
    return resolvedProjectRoot;
  }

  const startingDirectory = resolve(options.cwd ?? process.cwd());
  const gitRoot = await findGitRoot(startingDirectory);

  let currentDirectory = startingDirectory;
  while (true) {
    const configPath = resolveFromRoot(
      currentDirectory,
      trackedDirectoryName,
      "config.yaml",
    );
    if (await fileExists(configPath)) {
      await assertTrackedDirectoryWithinProjectRoot(currentDirectory);
      return currentDirectory;
    }

    if (currentDirectory === gitRoot) {
      break;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  throw new HttpiError(
    "PROJECT_NOT_FOUND",
    `No ${trackedDirectoryName}/config.yaml found from ${startingDirectory}. Run httpi init first.`,
    {
      exitCode: exitCodes.validationFailure,
    },
  );
}

async function assertTrackedDirectoryWithinProjectRoot(
  projectRoot: string,
): Promise<void> {
  const trackedRoot = resolveFromRoot(projectRoot, trackedDirectoryName);
  const trackedStats = await lstat(trackedRoot);
  if (trackedStats.isSymbolicLink()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `The tracked ${trackedDirectoryName} directory must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (!trackedStats.isDirectory()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `The tracked ${trackedDirectoryName} path must be a directory.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedTrackedRoot = await realpath(trackedRoot);
  assertPathWithin(resolvedProjectRoot, resolvedTrackedRoot, {
    code: "PROJECT_PATH_INVALID",
    message: `The tracked ${trackedDirectoryName} directory must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });
}

async function findGitRoot(startingDirectory: string): Promise<string> {
  let currentDirectory = startingDirectory;
  let latestGitRoot = currentDirectory;

  while (true) {
    if (await fileExists(resolveFromRoot(currentDirectory, ".git"))) {
      latestGitRoot = currentDirectory;
      break;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return latestGitRoot;
}

import { lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureRuntimePaths } from "@exit-zero-labs/httpi-runtime";
import {
  assertPathWithin,
  ensureDir,
  exitCodes,
  HttpiError,
  readUtf8File,
  resolveFromRoot,
  runtimeDirectoryName,
  trackedDirectoryName,
  writeUtf8File,
} from "@exit-zero-labs/httpi-shared";
import type { InitProjectResult } from "./types.js";

const schemaBaseUrl =
  "https://raw.githubusercontent.com/exit-zero-labs/httpi/main/packages/contracts/schemas";

function schemaComment(schemaFileName: string): string {
  return `# yaml-language-server: $schema=${schemaBaseUrl}/${schemaFileName}`;
}

export async function initProject(
  targetDirectory = process.cwd(),
): Promise<InitProjectResult> {
  const rootDir = resolve(targetDirectory);
  const trackedRoot = resolveFromRoot(rootDir, trackedDirectoryName);
  const gitignorePath = resolveFromRoot(rootDir, ".gitignore");
  const createdPaths: string[] = [];

  const hasGitignore = await ensureProjectOwnedFileIfExists(
    rootDir,
    gitignorePath,
    "The project .gitignore file",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    trackedRoot,
    "The tracked httpi directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "env"),
    "The tracked httpi/env directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "requests"),
    "The tracked httpi/requests directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "runs"),
    "The tracked httpi/runs directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "blocks", "headers"),
    "The tracked httpi/blocks/headers directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "blocks", "auth"),
    "The tracked httpi/blocks/auth directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "bodies"),
    "The tracked httpi/bodies directory",
  );
  await ensureRuntimePaths(rootDir);

  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(trackedRoot, "config.yaml"),
      [
        schemaComment("config.schema.json"),
        "schemaVersion: 1",
        `project: ${JSON.stringify(basename(rootDir) || "httpi-project")}`,
        "defaultEnv: dev",
        "",
        "defaults:",
        "  timeoutMs: 10000",
        "",
        "capture:",
        "  requestSummary: true",
        "  responseMetadata: true",
        "  responseBody: full",
        "  maxBodyBytes: 1048576",
        "  redactHeaders:",
        "    - authorization",
        "    - cookie",
        "    - set-cookie",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(trackedRoot, "env", "dev.env.yaml"),
      [
        schemaComment("env.schema.json"),
        "schemaVersion: 1",
        "title: Development",
        "values:",
        "  baseUrl: http://localhost:3000",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(trackedRoot, "requests", "ping.request.yaml"),
      [
        schemaComment("request.schema.json"),
        "kind: request",
        "title: Ping",
        "method: GET",
        'url: "{{baseUrl}}/ping"',
        "expect:",
        "  status: 200",
        "",
      ].join("\n"),
    )),
  );
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(trackedRoot, "runs", "smoke.run.yaml"),
      [
        schemaComment("run.schema.json"),
        "kind: run",
        "title: Smoke",
        "env: dev",
        "steps:",
        "  - kind: request",
        "    id: ping",
        "    uses: ping",
        "",
      ].join("\n"),
    )),
  );

  if (!hasGitignore) {
    await writeUtf8File(gitignorePath, `${runtimeDirectoryName}/\n`);
    createdPaths.push(gitignorePath);
  } else {
    const currentGitignore = await readUtf8File(gitignorePath);
    if (!currentGitignore.includes(`${runtimeDirectoryName}/`)) {
      const nextContent = currentGitignore.endsWith("\n")
        ? `${currentGitignore}${runtimeDirectoryName}/\n`
        : `${currentGitignore}\n${runtimeDirectoryName}/\n`;
      await writeUtf8File(gitignorePath, nextContent);
    }
  }

  return {
    rootDir,
    createdPaths,
  };
}

async function writeTemplateIfMissing(
  projectRoot: string,
  filePath: string,
  content: string,
): Promise<string[]> {
  if (
    await ensureProjectOwnedFileIfExists(
      projectRoot,
      filePath,
      `The tracked file ${filePath}`,
    )
  ) {
    return [];
  }

  await writeUtf8File(filePath, content);
  return [filePath];
}

async function ensureProjectOwnedDirectory(
  projectRoot: string,
  directoryPath: string,
  message: string,
): Promise<void> {
  await ensureDir(directoryPath);

  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }
  if (!stats.isDirectory()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `${message} must be a directory.`,
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedDirectoryPath = await realpath(directoryPath);
  assertPathWithin(resolvedProjectRoot, resolvedDirectoryPath, {
    code: "PROJECT_PATH_INVALID",
    message: `${message} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });
}

async function ensureProjectOwnedFileIfExists(
  projectRoot: string,
  filePath: string,
  message: string,
): Promise<boolean> {
  const stats = await lstat(filePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }
  if (!stats.isFile()) {
    throw new HttpiError("PROJECT_PATH_INVALID", `${message} must be a file.`, {
      exitCode: exitCodes.validationFailure,
    });
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedFilePath = await realpath(filePath);
  assertPathWithin(resolvedProjectRoot, resolvedFilePath, {
    code: "PROJECT_PATH_INVALID",
    message: `${message} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
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

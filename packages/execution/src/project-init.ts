import { lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureRuntimePaths } from "@exit-zero-labs/runmark-runtime";
import {
  assertPathWithin,
  ensureDir,
  exitCodes,
  RunmarkError,
  readUtf8File,
  resolveFromRoot,
  runtimeDirectoryName,
  trackedDirectoryName,
  writeUtf8File,
} from "@exit-zero-labs/runmark-shared";
import type { InitProjectResult } from "./types.js";

const schemaBaseUrl =
  "https://raw.githubusercontent.com/exit-zero-labs/runmark/main/packages/contracts/schemas";
const demoBaseUrl = "http://127.0.0.1:4318";
const initNextSteps = [
  "In another terminal: runmark demo start",
  "Then run: runmark run --run smoke",
];
const runtimeGitignoreSentinel = `${runtimeDirectoryName}/*`;
const runtimeGitignoreBlockLines = [
  "# runmark runtime state",
  runtimeGitignoreSentinel,
  `!${runtimeDirectoryName}/.gitkeep`,
  `!${runtimeDirectoryName}/history/`,
  `!${runtimeDirectoryName}/sessions/`,
  `${runtimeDirectoryName}/history/*`,
  `!${runtimeDirectoryName}/history/.gitkeep`,
  `${runtimeDirectoryName}/sessions/*`,
  `!${runtimeDirectoryName}/sessions/.gitkeep`,
];

function schemaComment(schemaFileName: string): string {
  return `# yaml-language-server: $schema=${schemaBaseUrl}/${schemaFileName}`;
}

export async function initProject(
  targetDirectory = process.cwd(),
): Promise<InitProjectResult> {
  const rootDir = resolve(targetDirectory);
  const trackedRoot = resolveFromRoot(rootDir, trackedDirectoryName);
  const runtimeRoot = resolveFromRoot(trackedRoot, "artifacts");
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
    "The tracked runmark directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "env"),
    "The tracked runmark/env directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "requests"),
    "The tracked runmark/requests directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "runs"),
    "The tracked runmark/runs directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "blocks", "headers"),
    "The tracked runmark/blocks/headers directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "blocks", "auth"),
    "The tracked runmark/blocks/auth directory",
  );
  await ensureProjectOwnedDirectory(
    rootDir,
    resolveFromRoot(trackedRoot, "bodies"),
    "The tracked runmark/bodies directory",
  );
  await ensureRuntimePaths(rootDir);
  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(runtimeRoot, ".gitkeep"),
      "",
    )),
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(runtimeRoot, "history", ".gitkeep"),
      "",
    )),
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(runtimeRoot, "sessions", ".gitkeep"),
      "",
    )),
  );

  createdPaths.push(
    ...(await writeTemplateIfMissing(
      rootDir,
      resolveFromRoot(trackedRoot, "config.yaml"),
        [
          schemaComment("config.schema.json"),
          "schemaVersion: 1",
          `project: ${JSON.stringify(basename(rootDir) || "runmark-project")}`,
          "defaultEnv: dev",
          "",
          "defaults:",
          "  timeoutMs: 10000",
          "",
          "capture:",
          "  # Prefer metadata-only response capture for first runs: it keeps smoke",
          "  # checks fast and artifacts small. Switch responseBody to `full` only",
          "  # when you need stored response bodies or body-based snapshots.",
          "  requestSummary: true",
          "  responseMetadata: true",
          "  responseBody: metadata",
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
          `  baseUrl: ${demoBaseUrl}`,
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
    await writeUtf8File(gitignorePath, `${buildRuntimeGitignoreBlock()}\n`);
    createdPaths.push(gitignorePath);
  } else {
    const currentGitignore = await readUtf8File(gitignorePath);
    if (!currentGitignore.includes(runtimeGitignoreSentinel)) {
      const nextContent = currentGitignore.endsWith("\n")
        ? `${currentGitignore}${buildRuntimeGitignoreBlock()}\n`
        : `${currentGitignore}\n${buildRuntimeGitignoreBlock()}\n`;
      await writeUtf8File(gitignorePath, nextContent);
    }
  }

  return {
    rootDir,
    createdPaths,
    nextSteps: initNextSteps,
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

function buildRuntimeGitignoreBlock(): string {
  return runtimeGitignoreBlockLines.join("\n");
}

async function ensureProjectOwnedDirectory(
  projectRoot: string,
  directoryPath: string,
  message: string,
): Promise<void> {
  await ensureDir(directoryPath);

  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new RunmarkError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }
  if (!stats.isDirectory()) {
    throw new RunmarkError(
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
    throw new RunmarkError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }
  if (!stats.isFile()) {
    throw new RunmarkError("PROJECT_PATH_INVALID", `${message} must be a file.`, {
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

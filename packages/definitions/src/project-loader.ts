import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AuthBlockDefinition,
  Diagnostic,
  EnvironmentDefinition,
  HeaderBlockDefinition,
  LoadedDefinition,
  ProjectConfig,
  ProjectFiles,
  RequestDefinition,
  RunDefinition,
} from "@exit-zero-labs/httpi-contracts";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import {
  assertPathWithin,
  envFileSuffix,
  exitCodes,
  fileExists,
  HttpiError,
  readUtf8File,
  relativeId,
  requestFileSuffix,
  resolveFromRoot,
  runFileSuffix,
  sha256Hex,
  trackedDirectoryName,
  walkFiles,
  yamlFileSuffix,
} from "@exit-zero-labs/httpi-shared";
import { LineCounter, parseDocument } from "yaml";
import {
  defaultCapturePolicy,
  detectSecretLiteralDiagnostics,
} from "./parsing-helpers.js";
import {
  parseAuthBlockDefinition,
  parseEnvironmentDefinition,
  parseHeaderBlockDefinition,
  parseProjectConfig,
} from "./project-file-parsers.js";
import { parseRequestDefinition } from "./request-parser.js";
import { parseRunDefinition } from "./run-parser.js";
import { validateProjectReferences } from "./validation.js";

export async function loadProjectFiles(
  projectRoot: string,
): Promise<ProjectFiles> {
  const trackedRoot = resolveFromRoot(projectRoot, trackedDirectoryName);
  const configPath = resolveFromRoot(trackedRoot, "config.yaml");
  const diagnostics: Diagnostic[] = [];

  const parsedConfig = await parseTypedYamlFile(
    projectRoot,
    configPath,
    "config",
    parseProjectConfig,
  );
  diagnostics.push(...parsedConfig.diagnostics);

  const environments = await loadDefinitionDirectory<EnvironmentDefinition>(
    projectRoot,
    resolveFromRoot(trackedRoot, "env"),
    "env",
    envFileSuffix,
    parseEnvironmentDefinition,
  );
  diagnostics.push(...environments.diagnostics);

  const headerBlocks = await loadDefinitionDirectory<HeaderBlockDefinition>(
    projectRoot,
    resolveFromRoot(trackedRoot, "blocks", "headers"),
    "header-block",
    yamlFileSuffix,
    parseHeaderBlockDefinition,
  );
  diagnostics.push(...headerBlocks.diagnostics);

  const authBlocks = await loadDefinitionDirectory<AuthBlockDefinition>(
    projectRoot,
    resolveFromRoot(trackedRoot, "blocks", "auth"),
    "auth-block",
    yamlFileSuffix,
    parseAuthBlockDefinition,
  );
  diagnostics.push(...authBlocks.diagnostics);

  const requests = await loadDefinitionDirectory<RequestDefinition>(
    projectRoot,
    resolveFromRoot(trackedRoot, "requests"),
    "request",
    requestFileSuffix,
    parseRequestDefinition,
  );
  diagnostics.push(...requests.diagnostics);

  const runs = await loadDefinitionDirectory<RunDefinition>(
    projectRoot,
    resolveFromRoot(trackedRoot, "runs"),
    "run",
    runFileSuffix,
    parseRunDefinition,
  );
  diagnostics.push(...runs.diagnostics);

  const config =
    parsedConfig.value ??
    createFallbackProjectConfig(resolve(projectRoot, trackedDirectoryName));
  const configHash = parsedConfig.hash ?? "";

  const projectFiles: ProjectFiles = {
    rootDir: resolve(projectRoot),
    configPath,
    configHash,
    config,
    environments: environments.files,
    headerBlocks: headerBlocks.files,
    authBlocks: authBlocks.files,
    requests: requests.files,
    runs: runs.files,
    diagnostics,
  };

  projectFiles.diagnostics.push(...validateProjectReferences(projectFiles));
  return projectFiles;
}

async function loadDefinitionDirectory<TDefinition>(
  projectRoot: string,
  directoryPath: string,
  kind: LoadedDefinition<TDefinition>["kind"],
  suffix: string,
  parser: (
    value: unknown,
    filePath: string,
  ) => {
    value?: TDefinition;
    diagnostics: Diagnostic[];
    title?: string | undefined;
  },
): Promise<{
  files: Record<string, LoadedDefinition<TDefinition>>;
  diagnostics: Diagnostic[];
}> {
  if (!(await fileExists(directoryPath))) {
    return {
      files: {},
      diagnostics: [],
    };
  }

  await assertProjectOwnedTrackedDirectory(
    projectRoot,
    directoryPath,
    `The tracked ${kind} directory`,
  );

  const filePaths = (await walkFiles(directoryPath)).filter((filePath) =>
    filePath.endsWith(suffix),
  );

  const diagnostics: Diagnostic[] = [];
  const files: Record<string, LoadedDefinition<TDefinition>> = {};

  for (const filePath of filePaths) {
    const parsedFile = await parseTypedYamlFile(
      projectRoot,
      filePath,
      kind,
      parser,
    );
    diagnostics.push(...parsedFile.diagnostics);
    if (!parsedFile.value || !parsedFile.hash) {
      continue;
    }

    const id = relativeId(filePath, directoryPath, suffix);
    files[id] = {
      kind,
      id,
      title: parsedFile.title,
      filePath,
      hash: parsedFile.hash,
      definition: parsedFile.value,
    };
  }

  return {
    files,
    diagnostics,
  };
}

async function parseTypedYamlFile<TValue>(
  projectRoot: string,
  filePath: string,
  kind: LoadedDefinition<TValue>["kind"],
  parser: (
    value: unknown,
    filePath: string,
  ) => {
    value?: TValue;
    diagnostics: Diagnostic[];
    title?: string | undefined;
  },
): Promise<{
  value?: TValue | undefined;
  diagnostics: Diagnostic[];
  hash?: string | undefined;
  title?: string | undefined;
}> {
  await assertProjectOwnedTrackedFile(
    projectRoot,
    filePath,
    `Tracked ${kind} file ${filePath}`,
  );
  const rawContent = await readUtf8File(filePath);
  const lineCounter = new LineCounter();
  const document = parseDocument(rawContent, {
    lineCounter,
    prettyErrors: false,
  });

  const diagnostics: Diagnostic[] = [];
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const position =
        typeof error.pos?.[0] === "number"
          ? lineCounter.linePos(error.pos[0])
          : undefined;
      diagnostics.push({
        level: "error",
        code: "YAML_PARSE_ERROR",
        message: error.message,
        filePath,
        line: position?.line,
        column: position?.col,
      });
    }

    return { diagnostics };
  }

  const result = parser(document.toJS(), filePath);
  result.diagnostics.push(
    ...detectSecretLiteralDiagnostics(document.toJS(), filePath, kind),
  );

  return {
    value: result.value,
    diagnostics: result.diagnostics,
    hash: sha256Hex(rawContent),
    title: result.title,
  };
}

function createFallbackProjectConfig(projectRoot: string): ProjectConfig {
  return {
    schemaVersion,
    project: projectRoot,
    defaults: {},
    capture: defaultCapturePolicy,
  };
}

async function assertProjectOwnedTrackedDirectory(
  projectRoot: string,
  directoryPath: string,
  message: string,
): Promise<void> {
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
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

async function assertProjectOwnedTrackedFile(
  projectRoot: string,
  filePath: string,
  message: string,
): Promise<void> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new HttpiError(
      "PROJECT_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
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
}

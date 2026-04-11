import { lstat, readFile, realpath } from "node:fs/promises";
import { extname } from "node:path";
import type {
  CompiledRequestStep,
  JsonValue,
  ResolvedRequestBody,
} from "@exit-zero-labs/httpi-contracts";
import {
  assertPathWithin,
  exitCodes,
  fileExists,
  HttpiError,
  resolveFromRoot,
  trackedDirectoryName,
} from "@exit-zero-labs/httpi-shared";
import { uniqueSecretValues } from "./request-secrets.js";
import {
  resolveStringValue,
  resolveTemplateValue,
} from "./request-variables.js";
import type { RequestResolutionContext } from "./types.js";

interface RequestBodyResolution {
  body: ResolvedRequestBody;
  secretValues: string[];
}

interface JsonValueResolution {
  value: JsonValue;
  secretValues: string[];
}

export async function resolveRequestBody(
  projectRoot: string,
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): Promise<RequestBodyResolution | undefined> {
  const bodyDefinition = step.request.body;
  if (!bodyDefinition) {
    return undefined;
  }

  if ("json" in bodyDefinition) {
    const resolvedJson = resolveJsonValue(bodyDefinition.json, context);
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "application/json",
        text: JSON.stringify(resolvedJson.value),
      },
      secretValues: resolvedJson.secretValues,
    };
  }

  if ("text" in bodyDefinition) {
    const resolvedText = resolveStringValue(bodyDefinition.text, context);
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "text/plain",
        text: resolvedText.value,
      },
      secretValues: resolvedText.secretValues,
    };
  }

  const bodiesDirectory = resolveFromRoot(
    projectRoot,
    trackedDirectoryName,
    "bodies",
  );
  if (await fileExists(bodiesDirectory)) {
    await assertProjectOwnedDirectory(
      projectRoot,
      bodiesDirectory,
      `The tracked ${trackedDirectoryName}/bodies directory`,
    );
  }
  const bodyFilePath = resolveFromRoot(bodiesDirectory, bodyDefinition.file);
  assertPathWithin(bodiesDirectory, bodyFilePath, {
    code: "BODY_FILE_PATH_INVALID",
    message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
    exitCode: exitCodes.validationFailure,
  });
  if (!(await fileExists(bodyFilePath))) {
    throw new HttpiError(
      "BODY_FILE_NOT_FOUND",
      `Body file ${bodyDefinition.file} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const bodyFileStats = await lstat(bodyFilePath);
  if (bodyFileStats.isSymbolicLink()) {
    throw new HttpiError(
      "BODY_FILE_PATH_INVALID",
      `Body file ${bodyDefinition.file} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedBodiesDirectory = await realpath(bodiesDirectory);
  const resolvedBodyFilePath = await realpath(bodyFilePath);
  assertPathWithin(resolvedBodiesDirectory, resolvedBodyFilePath, {
    code: "BODY_FILE_PATH_INVALID",
    message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
    exitCode: exitCodes.validationFailure,
  });

  const rawBody = await readFile(resolvedBodyFilePath);
  if (isTextExtension(resolvedBodyFilePath)) {
    const resolvedText = resolveStringValue(rawBody.toString("utf8"), context);
    return {
      body: {
        contentType:
          bodyDefinition.contentType ??
          inferContentTypeFromPath(resolvedBodyFilePath),
        text: resolvedText.value,
      },
      secretValues: resolvedText.secretValues,
    };
  }

  return {
    body: {
      contentType:
        bodyDefinition.contentType ??
        inferContentTypeFromPath(resolvedBodyFilePath),
      binary: rawBody,
    },
    secretValues: [],
  };
}

async function assertProjectOwnedDirectory(
  projectRoot: string,
  directoryPath: string,
  message: string,
): Promise<void> {
  const directoryStats = await lstat(directoryPath);
  if (directoryStats.isSymbolicLink()) {
    throw new HttpiError(
      "BODY_FILE_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (!directoryStats.isDirectory()) {
    throw new HttpiError(
      "BODY_FILE_PATH_INVALID",
      `${message} must be a directory.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedDirectoryPath = await realpath(directoryPath);
  assertPathWithin(resolvedProjectRoot, resolvedDirectoryPath, {
    code: "BODY_FILE_PATH_INVALID",
    message: `${message} must stay within the project root.`,
    exitCode: exitCodes.validationFailure,
  });
}

function resolveJsonValue(
  value: JsonValue,
  context: RequestResolutionContext,
): JsonValueResolution {
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return {
      value,
      secretValues: [],
    };
  }

  if (typeof value === "string") {
    const resolved = resolveTemplateValue(value, context);
    return {
      value: resolved.value,
      secretValues: resolved.secretValues,
    };
  }

  if (Array.isArray(value)) {
    const resolvedEntries = value.map((entry) =>
      resolveJsonValue(entry, context),
    );
    return {
      value: resolvedEntries.map((entry) => entry.value),
      secretValues: uniqueSecretValues(
        resolvedEntries.flatMap((entry) => entry.secretValues),
      ),
    };
  }

  const entries = Object.entries(value).map(
    ([key, entry]) => [key, resolveJsonValue(entry, context)] as const,
  );
  return {
    value: Object.fromEntries(
      entries.map(([key, entry]) => [key, entry.value]),
    ),
    secretValues: uniqueSecretValues(
      entries.flatMap(([, entry]) => entry.secretValues),
    ),
  };
}

function inferContentTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".txt") {
    return "text/plain";
  }
  if (extension === ".xml") {
    return "application/xml";
  }
  if (extension === ".csv") {
    return "text/csv";
  }

  return "application/octet-stream";
}

function isTextExtension(filePath: string): boolean {
  return [".json", ".txt", ".yaml", ".yml", ".xml", ".csv", ".md"].includes(
    extname(filePath).toLowerCase(),
  );
}

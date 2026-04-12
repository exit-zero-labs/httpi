import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname } from "node:path";
import type {
  BodyBinaryDefinition,
  BodyMultipartDefinition,
  CompiledRequestStep,
  JsonValue,
  ResolvedRequestBody,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
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

interface BodyDiagnosticLocation {
  filePath: string;
  path?: string | undefined;
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

  const diagnosticLocation: BodyDiagnosticLocation = {
    filePath: step.request.filePath,
    path: "body.file",
  };

  if ("json" in bodyDefinition) {
    const resolvedJson = resolveJsonValue(bodyDefinition.json, context, {
      filePath: step.request.filePath,
      path: "body.json",
    });
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "application/json",
        text: JSON.stringify(resolvedJson.value),
      },
      secretValues: resolvedJson.secretValues,
    };
  }

  if ("text" in bodyDefinition) {
    const resolvedText = resolveStringValue(bodyDefinition.text, context, {
      filePath: step.request.filePath,
      path: "body.text",
    });
    return {
      body: {
        contentType: bodyDefinition.contentType ?? "text/plain",
        text: resolvedText.value,
      },
      secretValues: resolvedText.secretValues,
    };
  }

  if ("kind" in bodyDefinition && bodyDefinition.kind === "multipart") {
    return resolveMultipartBody(projectRoot, step, bodyDefinition, context);
  }

  if ("kind" in bodyDefinition && bodyDefinition.kind === "binary") {
    return resolveBinaryBody(projectRoot, step, bodyDefinition, context);
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
      diagnosticLocation,
    );
  }
  const bodyFilePath = resolveFromRoot(bodiesDirectory, bodyDefinition.file);
  try {
    assertPathWithin(bodiesDirectory, bodyFilePath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyResolutionError(
        "BODY_FILE_PATH_INVALID",
        error.message,
        diagnosticLocation,
        "Update body.file so it points to a file inside httpi/bodies.",
      );
    }

    throw error;
  }
  if (!(await fileExists(bodyFilePath))) {
    throw buildBodyResolutionError(
      "BODY_FILE_NOT_FOUND",
      `Body file ${bodyDefinition.file} was not found.`,
      diagnosticLocation,
      "Create the referenced body file or update body.file to an existing file inside httpi/bodies.",
    );
  }

  const bodyFileStats = await lstat(bodyFilePath);
  if (bodyFileStats.isSymbolicLink()) {
    throw buildBodyResolutionError(
      "BODY_FILE_PATH_INVALID",
      `Body file ${bodyDefinition.file} must not resolve through a symlink.`,
      diagnosticLocation,
      "Replace the symlink with a real tracked body file inside httpi/bodies.",
    );
  }

  const resolvedBodiesDirectory = await realpath(bodiesDirectory);
  const resolvedBodyFilePath = await realpath(bodyFilePath);
  try {
    assertPathWithin(resolvedBodiesDirectory, resolvedBodyFilePath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyResolutionError(
        "BODY_FILE_PATH_INVALID",
        error.message,
        diagnosticLocation,
        "Update body.file so it points to a file inside httpi/bodies.",
      );
    }

    throw error;
  }

  const rawBody = await readFile(resolvedBodyFilePath);
  if (isTextExtension(resolvedBodyFilePath)) {
    const resolvedText = resolveStringValue(rawBody.toString("utf8"), context, {
      filePath: resolvedBodyFilePath,
    });
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
  diagnosticLocation: BodyDiagnosticLocation,
): Promise<void> {
  const directoryStats = await lstat(directoryPath);
  if (directoryStats.isSymbolicLink()) {
    throw buildBodyResolutionError(
      "BODY_FILE_PATH_INVALID",
      `${message} must not resolve through a symlink.`,
      diagnosticLocation,
      "Replace the symlinked httpi/bodies directory with a real tracked directory.",
    );
  }
  if (!directoryStats.isDirectory()) {
    throw buildBodyResolutionError(
      "BODY_FILE_PATH_INVALID",
      `${message} must be a directory.`,
      diagnosticLocation,
      "Restore httpi/bodies as a directory before referencing body files from requests.",
    );
  }

  const resolvedProjectRoot = await realpath(projectRoot);
  const resolvedDirectoryPath = await realpath(directoryPath);
  try {
    assertPathWithin(resolvedProjectRoot, resolvedDirectoryPath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `${message} must stay within the project root.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyResolutionError(
        "BODY_FILE_PATH_INVALID",
        error.message,
        diagnosticLocation,
        "Restore httpi/bodies inside the project root before referencing body files from requests.",
      );
    }

    throw error;
  }
}

function resolveJsonValue(
  value: JsonValue,
  context: RequestResolutionContext,
  diagnosticLocation: BodyDiagnosticLocation,
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
    const resolved = resolveTemplateValue(value, context, diagnosticLocation);
    return {
      value: resolved.value,
      secretValues: resolved.secretValues,
    };
  }

  if (Array.isArray(value)) {
    const resolvedEntries = value.map((entry, index) =>
      resolveJsonValue(
        entry,
        context,
        appendBodyDiagnosticPath(diagnosticLocation, index),
      ),
    );
    return {
      value: resolvedEntries.map((entry) => entry.value),
      secretValues: uniqueSecretValues(
        resolvedEntries.flatMap((entry) => entry.secretValues),
      ),
    };
  }

  const entries = Object.entries(value).map(
    ([key, entry]) =>
      [
        key,
        resolveJsonValue(
          entry,
          context,
          appendBodyDiagnosticPath(diagnosticLocation, key),
        ),
      ] as const,
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

function appendBodyDiagnosticPath(
  diagnosticLocation: BodyDiagnosticLocation,
  segment: string | number,
): BodyDiagnosticLocation {
  return {
    ...diagnosticLocation,
    path: diagnosticLocation.path
      ? appendDiagnosticPath(diagnosticLocation.path, segment)
      : undefined,
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

function sanitizeDispositionValue(value: string): string {
  return value.replace(/["\\]/g, "_").replace(/[\r\n]/g, "");
}

async function resolveMultipartBody(
  projectRoot: string,
  step: CompiledRequestStep,
  bodyDefinition: BodyMultipartDefinition,
  context: RequestResolutionContext,
): Promise<RequestBodyResolution> {
  const boundary = `----httpi-${randomBytes(16).toString("hex")}`;
  const allSecrets: string[] = [];
  const bufferParts: Buffer[] = [];

  const bodiesDirectory = resolveFromRoot(
    projectRoot,
    trackedDirectoryName,
    "bodies",
  );
  const diagnosticLocation: BodyDiagnosticLocation = {
    filePath: step.request.filePath,
    path: "body.parts",
  };

  for (const part of bodyDefinition.parts) {
    const safeName = sanitizeDispositionValue(part.name);
    bufferParts.push(Buffer.from(`--${boundary}\r\n`, "utf8"));

    if (part.file) {
      const safeFile = sanitizeDispositionValue(part.file);
      const filePath = resolveFromRoot(bodiesDirectory, part.file);

      // Path traversal protection — same checks as resolveBinaryBody
      try {
        assertPathWithin(bodiesDirectory, filePath, {
          code: "BODY_FILE_PATH_INVALID",
          message: `Multipart part file ${part.file} must stay within httpi/bodies.`,
          exitCode: exitCodes.validationFailure,
        });
      } catch (error) {
        if (
          error instanceof HttpiError &&
          error.code === "BODY_FILE_PATH_INVALID"
        ) {
          throw buildBodyResolutionError(
            "BODY_FILE_PATH_INVALID",
            (error as HttpiError).message,
            diagnosticLocation,
            "Update the multipart part file path to stay within httpi/bodies.",
          );
        }
        throw error;
      }

      if (!(await fileExists(filePath))) {
        throw buildBodyResolutionError(
          "BODY_FILE_NOT_FOUND",
          `Multipart part file ${part.file} was not found.`,
          diagnosticLocation,
          "Create the referenced file inside httpi/bodies.",
        );
      }

      const fileStats = await lstat(filePath);
      if (fileStats.isSymbolicLink()) {
        throw buildBodyResolutionError(
          "BODY_FILE_PATH_INVALID",
          `Multipart part file ${part.file} must not be a symlink.`,
          diagnosticLocation,
          "Replace the symlink with a real file inside httpi/bodies.",
        );
      }

      const resolvedBodies = await realpath(bodiesDirectory);
      const resolvedFile = await realpath(filePath);
      try {
        assertPathWithin(resolvedBodies, resolvedFile, {
          code: "BODY_FILE_PATH_INVALID",
          message: `Multipart part file ${part.file} must stay within httpi/bodies.`,
          exitCode: exitCodes.validationFailure,
        });
      } catch (error) {
        if (
          error instanceof HttpiError &&
          error.code === "BODY_FILE_PATH_INVALID"
        ) {
          throw buildBodyResolutionError(
            "BODY_FILE_PATH_INVALID",
            (error as HttpiError).message,
            diagnosticLocation,
            "Update the multipart part file path to stay within httpi/bodies.",
          );
        }
        throw error;
      }

      const fileContent = await readFile(resolvedFile);
      const ct = part.contentType ?? inferContentTypeFromPath(part.file);
      bufferParts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${safeName}"; filename="${safeFile}"\r\nContent-Type: ${ct}\r\n\r\n`,
          "utf8",
        ),
      );
      bufferParts.push(fileContent);
      bufferParts.push(Buffer.from("\r\n", "utf8"));
    } else if (part.json !== undefined) {
      const resolved = resolveJsonValue(part.json, context, {
        filePath: step.request.filePath,
        path: `body.parts.${part.name}`,
      });
      allSecrets.push(...resolved.secretValues);
      bufferParts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${safeName}"\r\nContent-Type: application/json\r\n\r\n`,
          "utf8",
        ),
      );
      bufferParts.push(Buffer.from(JSON.stringify(resolved.value), "utf8"));
      bufferParts.push(Buffer.from("\r\n", "utf8"));
    } else if (part.text !== undefined) {
      const resolved = resolveStringValue(part.text, context, {
        filePath: step.request.filePath,
        path: `body.parts.${part.name}`,
      });
      allSecrets.push(...resolved.secretValues);
      bufferParts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${safeName}"\r\n\r\n`,
          "utf8",
        ),
      );
      bufferParts.push(Buffer.from(resolved.value, "utf8"));
      bufferParts.push(Buffer.from("\r\n", "utf8"));
    }
  }

  bufferParts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    body: {
      contentType: `multipart/form-data; boundary=${boundary}`,
      binary: Buffer.concat(bufferParts),
    },
    secretValues: uniqueSecretValues(allSecrets),
  };
}

async function resolveBinaryBody(
  projectRoot: string,
  step: CompiledRequestStep,
  bodyDefinition: BodyBinaryDefinition,
  _context: RequestResolutionContext,
): Promise<RequestBodyResolution> {
  const diagnosticLocation: BodyDiagnosticLocation = {
    filePath: step.request.filePath,
    path: "body.file",
  };

  const bodiesDirectory = resolveFromRoot(
    projectRoot,
    trackedDirectoryName,
    "bodies",
  );
  const bodyFilePath = resolveFromRoot(bodiesDirectory, bodyDefinition.file);

  try {
    assertPathWithin(bodiesDirectory, bodyFilePath, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyResolutionError(
        "BODY_FILE_PATH_INVALID",
        error.message,
        diagnosticLocation,
        "Update body.file so it points to a file inside httpi/bodies.",
      );
    }
    throw error;
  }

  if (!(await fileExists(bodyFilePath))) {
    throw buildBodyResolutionError(
      "BODY_FILE_NOT_FOUND",
      `Body file ${bodyDefinition.file} was not found.`,
      diagnosticLocation,
      "Create the referenced body file or update body.file to an existing file inside httpi/bodies.",
    );
  }

  // Symlink check — match the protection level of the standard file body path
  const bodyFileStats = await lstat(bodyFilePath);
  if (bodyFileStats.isSymbolicLink()) {
    throw buildBodyResolutionError(
      "BODY_FILE_PATH_INVALID",
      `Body file ${bodyDefinition.file} must not resolve through a symlink.`,
      diagnosticLocation,
      "Replace the symlink with a real tracked body file inside httpi/bodies.",
    );
  }

  const resolvedBodiesDir = await realpath(bodiesDirectory);
  const resolvedBodyFile = await realpath(bodyFilePath);
  try {
    assertPathWithin(resolvedBodiesDir, resolvedBodyFile, {
      code: "BODY_FILE_PATH_INVALID",
      message: `Body file ${bodyDefinition.file} must stay within httpi/bodies.`,
      exitCode: exitCodes.validationFailure,
    });
  } catch (error) {
    if (
      error instanceof HttpiError &&
      error.code === "BODY_FILE_PATH_INVALID"
    ) {
      throw buildBodyResolutionError(
        "BODY_FILE_PATH_INVALID",
        error.message,
        diagnosticLocation,
        "Update body.file so it points to a file inside httpi/bodies.",
      );
    }
    throw error;
  }

  const rawBody = await readFile(resolvedBodyFile);
  return {
    body: {
      contentType: bodyDefinition.contentType ?? "application/octet-stream",
      binary: rawBody,
    },
    secretValues: [],
  };
}

function buildBodyResolutionError(
  code: string,
  message: string,
  diagnosticLocation: BodyDiagnosticLocation,
  hint: string,
): HttpiError {
  return new HttpiError(code, message, {
    exitCode: exitCodes.validationFailure,
    details: [
      {
        level: "error" as const,
        code,
        message,
        hint,
        filePath: diagnosticLocation.filePath,
        ...(diagnosticLocation.path ? { path: diagnosticLocation.path } : {}),
      },
    ],
  });
}

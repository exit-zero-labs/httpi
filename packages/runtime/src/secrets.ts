import { chmod, lstat, realpath } from "node:fs/promises";
import {
  assertPathWithin,
  exitCodes,
  fileExists,
  HttpiError,
  readUtf8File,
} from "@exit-zero-labs/httpi-shared";
import { parseDocument } from "yaml";
import { ensureRuntimePaths, runtimeFileMode } from "./runtime-paths.js";

export async function loadSecrets(
  projectRoot: string,
): Promise<Record<string, string>> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  if (!(await fileExists(runtimePaths.secretsPath))) {
    return {};
  }

  const secretsStats = await lstat(runtimePaths.secretsPath);
  if (secretsStats.isSymbolicLink()) {
    throw new HttpiError(
      "SECRETS_PATH_INVALID",
      "The local .httpi/secrets.yaml file must not resolve through a symlink.",
      { exitCode: exitCodes.validationFailure },
    );
  }
  const resolvedRuntimeDir = await realpath(runtimePaths.runtimeDir);
  const resolvedSecretsPath = await realpath(runtimePaths.secretsPath);
  assertPathWithin(resolvedRuntimeDir, resolvedSecretsPath, {
    code: "SECRETS_PATH_INVALID",
    message: "The local .httpi/secrets.yaml file must stay within .httpi/.",
    exitCode: exitCodes.validationFailure,
  });
  if (process.platform !== "win32") {
    await chmod(runtimePaths.secretsPath, runtimeFileMode);
  }

  const rawContent = await readUtf8File(runtimePaths.secretsPath);
  const document = parseDocument(rawContent);
  if (document.errors.length > 0) {
    throw new HttpiError(
      "SECRETS_INVALID",
      "The local .httpi/secrets.yaml file could not be parsed.",
      {
        exitCode: exitCodes.validationFailure,
        details: document.errors.map((error) => error.message),
      },
    );
  }

  const parsedValue = document.toJS();
  const valuesRecord = isStringRecord(parsedValue)
    ? parsedValue
    : extractValuesRecord(parsedValue);

  if (!valuesRecord) {
    throw new HttpiError(
      "SECRETS_INVALID",
      "The local .httpi/secrets.yaml file must be a string map or contain a values string map.",
      {
        exitCode: exitCodes.validationFailure,
      },
    );
  }

  return valuesRecord;
}

function extractValuesRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "values" in value &&
    isStringRecord(value.values)
  ) {
    return value.values;
  }

  return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

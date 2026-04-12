import type {
  AuthBlockDefinition,
  Diagnostic,
  EnvironmentDefinition,
  HeaderBlockDefinition,
  ProjectConfig,
} from "@exit-zero-labs/httpi-contracts";
import { asRecord } from "@exit-zero-labs/httpi-shared";
import {
  expectRecord,
  normalizeCapturePolicy,
  readFlatVariableMap,
  readOptionalSchemaVersion,
  readOptionalString,
  readRequiredString,
  readSchemaVersion,
  readStringMap,
} from "./parsing-helpers.js";
import { parseAuthDefinition } from "./request-parser.js";

export function parseProjectConfig(
  value: unknown,
  filePath: string,
): {
  value?: ProjectConfig;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "config");
  if (!record) {
    return { diagnostics };
  }

  const parsedSchemaVersion = readSchemaVersion(record, filePath, diagnostics);
  const project = readRequiredString(
    record,
    "project",
    filePath,
    diagnostics,
    "Project config requires a string project name.",
  );
  const defaultEnv = readOptionalString(
    record,
    "defaultEnv",
    filePath,
    diagnostics,
  );
  const defaults = readFlatVariableMap(
    record.defaults,
    filePath,
    diagnostics,
    "defaults",
  );
  const capture = normalizeCapturePolicy(record.capture, filePath, diagnostics);

  if (!parsedSchemaVersion || !project) {
    return { diagnostics };
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      project,
      defaultEnv,
      defaults,
      capture,
    },
    diagnostics,
  };
}

export function parseEnvironmentDefinition(
  value: unknown,
  filePath: string,
): {
  value?: EnvironmentDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "environment");
  if (!record) {
    return { diagnostics };
  }

  const parsedSchemaVersion = readSchemaVersion(record, filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const values = readFlatVariableMap(
    record.values,
    filePath,
    diagnostics,
    "values",
  );

  if (!parsedSchemaVersion) {
    return { diagnostics };
  }

  // Parse environment guards (D4)
  let guards: EnvironmentDefinition["guards"];
  if (record.guards !== undefined) {
    const guardsRecord = asRecord(record.guards);
    if (guardsRecord) {
      guards = {
        requireEnv:
          typeof guardsRecord.requireEnv === "string"
            ? guardsRecord.requireEnv
            : undefined,
        requireFlag:
          typeof guardsRecord.requireFlag === "string"
            ? guardsRecord.requireFlag
            : undefined,
        blockParallelAbove:
          typeof guardsRecord.blockParallelAbove === "number"
            ? guardsRecord.blockParallelAbove
            : undefined,
        blockIfBranchNotIn:
          Array.isArray(guardsRecord.blockIfBranchNotIn) &&
          guardsRecord.blockIfBranchNotIn.every(
            (s: unknown) => typeof s === "string",
          )
            ? guardsRecord.blockIfBranchNotIn
            : undefined,
        denyHosts:
          Array.isArray(guardsRecord.denyHosts) &&
          guardsRecord.denyHosts.every((s: unknown) => typeof s === "string")
            ? guardsRecord.denyHosts
            : undefined,
      };
    }
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      guards,
      values,
    },
    diagnostics,
    title,
  };
}

export function parseHeaderBlockDefinition(
  value: unknown,
  filePath: string,
): {
  value?: HeaderBlockDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "header block");
  if (!record) {
    return { diagnostics };
  }

  const title = readOptionalString(record, "title", filePath, diagnostics);
  const parsedSchemaVersion = readOptionalSchemaVersion(
    record,
    filePath,
    diagnostics,
  );
  const headers = readStringMap(
    record.headers,
    filePath,
    diagnostics,
    "headers",
  );

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      headers,
    },
    diagnostics,
    title,
  };
}

export function parseAuthBlockDefinition(
  value: unknown,
  filePath: string,
): {
  value?: AuthBlockDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "auth block");
  if (!record) {
    return { diagnostics };
  }

  const title = readOptionalString(record, "title", filePath, diagnostics);
  const parsedSchemaVersion = readOptionalSchemaVersion(
    record,
    filePath,
    diagnostics,
  );
  const auth = parseAuthDefinition(record.auth, filePath, diagnostics, "auth");
  if (!auth) {
    return { diagnostics };
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      auth,
    },
    diagnostics,
    title,
  };
}

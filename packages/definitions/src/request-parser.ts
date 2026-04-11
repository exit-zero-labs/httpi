import type {
  AuthDefinition,
  Diagnostic,
  RequestBodyDefinition,
  RequestDefinition,
  RequestExpectation,
  RequestUses,
} from "@exit-zero-labs/httpi-contracts";
import { asRecord } from "@exit-zero-labs/httpi-shared";
import {
  expectRecord,
  isJsonValue,
  readHttpMethod,
  readLiteral,
  readOptionalBoolean,
  readOptionalFlatVariableMap,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringMap,
  readRequiredString,
} from "./parsing-helpers.js";

export function parseRequestDefinition(
  value: unknown,
  filePath: string,
): {
  value?: RequestDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "request");
  if (!record) {
    return { diagnostics };
  }

  const kind = readLiteral(record, "kind", "request", filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const method = readHttpMethod(record, filePath, diagnostics);
  const url = readRequiredString(
    record,
    "url",
    filePath,
    diagnostics,
    "Request definitions require a string url.",
  );
  const uses = parseRequestUses(record.uses, filePath, diagnostics);
  const defaults = readOptionalFlatVariableMap(
    record.defaults,
    filePath,
    diagnostics,
    "defaults",
  );
  const headers = readOptionalStringMap(
    record.headers,
    filePath,
    diagnostics,
    "headers",
  );
  const auth = parseOptionalAuthDefinition(
    record.auth,
    filePath,
    diagnostics,
    "auth",
  );
  const body = parseOptionalBodyDefinition(record.body, filePath, diagnostics);
  const expect = parseOptionalExpect(record.expect, filePath, diagnostics);
  const extract = parseOptionalExtract(record.extract, filePath, diagnostics);
  const timeoutMs = readOptionalNumber(
    record,
    "timeoutMs",
    filePath,
    diagnostics,
  );

  if (!kind || !method || !url) {
    return { diagnostics };
  }

  if (auth && uses?.auth) {
    diagnostics.push({
      level: "error",
      code: "AUTH_CONFLICT",
      message: "Requests may define inline auth or uses.auth, but not both.",
      filePath,
      path: "auth",
    });
  }

  const requestDefinition: RequestDefinition = {
    kind,
    title,
    method,
    url,
    uses,
    defaults,
    headers,
    auth,
    body,
    expect,
    extract,
    timeoutMs,
  };

  return {
    value: requestDefinition,
    diagnostics,
    title,
  };
}

function parseRequestUses(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestUses | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_REQUEST_USES",
      message: "uses must be an object when present.",
      filePath,
      path: "uses",
    });
    return undefined;
  }

  const headersValue = record.headers;
  let headers: string[] | undefined;
  if (headersValue !== undefined) {
    if (
      !Array.isArray(headersValue) ||
      headersValue.some((entry) => typeof entry !== "string")
    ) {
      diagnostics.push({
        level: "error",
        code: "INVALID_HEADER_REFERENCES",
        message: "uses.headers must be an array of strings.",
        filePath,
        path: "uses.headers",
      });
    } else {
      headers = headersValue;
    }
  }

  const auth = readOptionalString(record, "auth", filePath, diagnostics);
  return {
    headers,
    auth,
  };
}

function parseOptionalExpect(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestExpectation | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXPECT",
      message: "expect must be an object when present.",
      filePath,
      path: "expect",
    });
    return undefined;
  }

  const status = record.status;
  if (status === undefined) {
    return {};
  }

  if (typeof status === "number") {
    return { status };
  }

  if (
    Array.isArray(status) &&
    status.every((entry) => typeof entry === "number")
  ) {
    return { status };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_EXPECT_STATUS",
    message: "expect.status must be a number or array of numbers.",
    filePath,
    path: "expect.status",
  });
  return undefined;
}

function parseOptionalExtract(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestDefinition["extract"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXTRACT",
      message: "extract must be an object when present.",
      filePath,
      path: "extract",
    });
    return undefined;
  }

  const extractEntries: NonNullable<RequestDefinition["extract"]> = {};
  for (const [key, extractValue] of Object.entries(record)) {
    const extractRecord = asRecord(extractValue);
    if (!extractRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_EXTRACT_ENTRY",
        message: `extract.${key} must be an object.`,
        filePath,
        path: `extract.${key}`,
      });
      continue;
    }

    const from = readRequiredString(
      extractRecord,
      "from",
      filePath,
      diagnostics,
      `extract.${key}.from must be a string.`,
    );
    const required = readOptionalBoolean(
      extractRecord,
      "required",
      filePath,
      diagnostics,
    );
    const secret = readOptionalBoolean(
      extractRecord,
      "secret",
      filePath,
      diagnostics,
    );
    if (!from) {
      continue;
    }

    extractEntries[key] = {
      from,
      required,
      secret,
    };
  }

  return extractEntries;
}

function parseOptionalBodyDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestBodyDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_BODY",
      message: "body must be an object when present.",
      filePath,
      path: "body",
    });
    return undefined;
  }

  const contentType = readOptionalString(
    record,
    "contentType",
    filePath,
    diagnostics,
  );
  if ("file" in record) {
    const file = readRequiredString(
      record,
      "file",
      filePath,
      diagnostics,
      "body.file must be a string.",
    );
    if (!file) {
      return undefined;
    }

    return { file, contentType };
  }

  if ("json" in record) {
    const json = record.json;
    if (!isJsonValue(json)) {
      diagnostics.push({
        level: "error",
        code: "INVALID_JSON_BODY",
        message: "body.json must be valid JSON data.",
        filePath,
        path: "body.json",
      });
      return undefined;
    }

    return { json, contentType };
  }

  if ("text" in record) {
    const text = readRequiredString(
      record,
      "text",
      filePath,
      diagnostics,
      "body.text must be a string.",
    );
    if (!text) {
      return undefined;
    }

    return { text, contentType };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_BODY_KIND",
    message: "body must define one of file, json, or text.",
    filePath,
    path: "body",
  });
  return undefined;
}

function parseOptionalAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseAuthDefinition(value, filePath, diagnostics, path);
}

export function parseAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_AUTH",
      message: `${path} must be an object.`,
      filePath,
      path,
    });
    return undefined;
  }

  const scheme = readRequiredString(
    record,
    "scheme",
    filePath,
    diagnostics,
    `${path}.scheme must be a string.`,
  );
  if (!scheme) {
    return undefined;
  }

  if (scheme === "bearer") {
    const token = readRequiredString(
      record,
      "token",
      filePath,
      diagnostics,
      `${path}.token must be a string.`,
    );
    if (!token) {
      return undefined;
    }

    return { scheme, token };
  }

  if (scheme === "basic") {
    const username = readRequiredString(
      record,
      "username",
      filePath,
      diagnostics,
      `${path}.username must be a string.`,
    );
    const password = readRequiredString(
      record,
      "password",
      filePath,
      diagnostics,
      `${path}.password must be a string.`,
    );
    if (!username || !password) {
      return undefined;
    }

    return {
      scheme,
      username,
      password,
    };
  }

  if (scheme === "header") {
    const header = readRequiredString(
      record,
      "header",
      filePath,
      diagnostics,
      `${path}.header must be a string.`,
    );
    const authValue = readRequiredString(
      record,
      "value",
      filePath,
      diagnostics,
      `${path}.value must be a string.`,
    );
    if (!header || !authValue) {
      return undefined;
    }

    return {
      scheme,
      header,
      value: authValue,
    };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_AUTH_SCHEME",
    message: `${path}.scheme must be one of bearer, basic, or header.`,
    filePath,
    path: `${path}.scheme`,
  });
  return undefined;
}

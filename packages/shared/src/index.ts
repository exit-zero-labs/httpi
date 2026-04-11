import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const trackedDirectoryName = "httpi";
export const runtimeDirectoryName = ".httpi";
export const requestFileSuffix = ".request.yaml";
export const runFileSuffix = ".run.yaml";
export const envFileSuffix = ".env.yaml";
export const yamlFileSuffix = ".yaml";
export const redactedValue = "[REDACTED]";
const decimalNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const secretFieldPattern =
  /(token|password|secret|api[-_]?key|authorization|cookie)/i;

export const exitCodes = {
  success: 0,
  executionFailure: 1,
  validationFailure: 2,
  unsafeResume: 3,
  internalError: 4,
} as const;

export class HttpiError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      details?: unknown;
      exitCode?: number;
    },
  ) {
    super(message, {
      cause: options?.cause instanceof Error ? options.cause : undefined,
    });
    this.name = "HttpiError";
    this.code = code;
    this.exitCode = options?.exitCode ?? exitCodes.internalError;
    this.details = options?.details;
  }
}

export function isHttpiError(error: unknown): error is HttpiError {
  return error instanceof HttpiError;
}

export function assert(
  condition: unknown,
  code: string,
  message: string,
  exitCode = exitCodes.internalError,
): asserts condition {
  if (!condition) {
    throw new HttpiError(code, message, { exitCode });
  }
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

export function relativeId(
  filePath: string,
  baseDir: string,
  suffix: string,
): string {
  const relativePath = toPosixPath(relative(baseDir, filePath));
  if (!relativePath.endsWith(suffix)) {
    throw new HttpiError(
      "INVALID_DEFINITION_PATH",
      `Expected ${filePath} to end with ${suffix}.`,
    );
  }

  return relativePath.slice(0, -suffix.length);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortValue(value[key]);
      return result;
    }, {});
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSessionId(prefix = "session"): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function createLockOwnerId(): string {
  return `lock-${randomUUID()}`;
}

export function toIsoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export async function ensureDir(path: string, mode?: number): Promise<void> {
  await mkdir(path, {
    recursive: true,
    ...(mode !== undefined ? { mode } : {}),
  });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

export async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeUtf8File(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
}

export async function readJsonFile<TValue>(path: string): Promise<TValue> {
  const content = await readUtf8File(path);
  return JSON.parse(content) as TValue;
}

export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await writeFileAtomic(path, `${stableStringify(value)}\n`, {
    ...(mode !== undefined ? { mode } : {}),
  });
}

export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: {
    encoding?: BufferEncoding;
    mode?: number;
  } = {},
): Promise<void> {
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  if (typeof content === "string") {
    await writeFile(temporaryPath, content, {
      encoding: options.encoding ?? "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
  } else {
    await writeFile(temporaryPath, content, {
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
  }

  await rename(temporaryPath, path);
}

export async function appendJsonLine(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await ensureDir(dirname(path));
  const handle = await open(path, "a", mode);

  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }
}

export async function walkFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = resolve(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

export function mergeStringRecords(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const record of records) {
    if (!record) {
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      result[key] = value;
    }
  }

  return result;
}

export interface TemplateInterpolationResult {
  value: string;
  tokens: string[];
  unresolved: string[];
}

export function interpolateTemplate(
  template: string,
  resolver: (token: string) => string | undefined,
): TemplateInterpolationResult {
  const tokens: string[] = [];
  const unresolved: string[] = [];

  const value = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, rawToken) => {
    const token = String(rawToken).trim();
    tokens.push(token);
    const resolved = resolver(token);
    if (resolved === undefined) {
      unresolved.push(token);
      return `{{${token}}}`;
    }

    return resolved;
  });

  return {
    value,
    tokens,
    unresolved,
  };
}

export function listTemplateTokens(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].flatMap((match) => {
    const token = match[1];
    return token ? [token.trim()] : [];
  });
}

export function looksLikeSecretFieldName(value: string): boolean {
  return secretFieldPattern.test(value);
}

export function redactText(
  value: string,
  secretValues: Iterable<string>,
): string {
  let redacted = value;
  const sortedSecretValues = [...new Set(secretValues)]
    .filter(
      (secretValue) => secretValue.length > 0 && secretValue !== redactedValue,
    )
    .sort((left, right) => right.length - left.length);

  for (const secretValue of sortedSecretValues) {
    redacted = redacted.split(secretValue).join(redactedValue);
  }

  return redacted;
}

export function redactHeaders(
  headers: Record<string, string>,
  headerNames: Iterable<string>,
  secretValues: Iterable<string>,
): Record<string, string> {
  const redactedHeaderNames = new Set(
    [...headerNames].map((name) => normalizeHeaderName(name)),
  );

  return Object.entries(headers).reduce<Record<string, string>>(
    (result, [name, value]) => {
      if (redactedHeaderNames.has(normalizeHeaderName(name))) {
        result[name] = redactedValue;
        return result;
      }

      result[name] = redactText(value, secretValues);
      return result;
    },
    {},
  );
}

export function coerceFlatValue(
  value: string,
): string | number | boolean | null {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  if (decimalNumberPattern.test(value)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return value;
}

export function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function coerceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

export function parseJsonIfPossible(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function resolveFromRoot(
  rootDir: string,
  ...segments: string[]
): string {
  return resolve(rootDir, ...segments);
}

export function assertPathWithin(
  rootDir: string,
  candidatePath: string,
  options: {
    code: string;
    message: string;
    exitCode?: number;
  },
): void {
  const resolvedRootDir = resolve(rootDir);
  const resolvedCandidatePath = resolve(candidatePath);
  const relativePath = relative(resolvedRootDir, resolvedCandidatePath);

  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    return;
  }

  throw new HttpiError(options.code, options.message, {
    exitCode: options.exitCode ?? exitCodes.validationFailure,
    details: {
      rootDir: resolvedRootDir,
      candidatePath: resolvedCandidatePath,
    },
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

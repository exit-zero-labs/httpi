import { Buffer } from "node:buffer";
import type {
  CompiledRequestStep,
  CompiledRunSnapshot,
  FlatVariableValue,
} from "@exit-zero-labs/httpi-contracts";
import { loadSecrets } from "@exit-zero-labs/httpi-runtime";
import {
  exitCodes,
  HttpiError,
  mergeStringRecords,
  normalizeHeaderName,
} from "@exit-zero-labs/httpi-shared";
import { resolveRequestBody } from "./request-body.js";
import { uniqueSecretValues } from "./request-secrets.js";
import {
  collectVariableExplanations,
  resolveStringValue,
} from "./request-variables.js";
import type {
  RequestMaterializationResult,
  RequestResolutionContext,
} from "./types.js";

export async function materializeRequest(
  projectRoot: string,
  compiled: CompiledRunSnapshot,
  step: CompiledRequestStep,
  stepOutputs: Record<string, Record<string, FlatVariableValue>>,
  secretStepOutputs: Record<string, string[]>,
): Promise<RequestMaterializationResult> {
  const context = await createRequestResolutionContext(
    projectRoot,
    compiled,
    step,
    stepOutputs,
    secretStepOutputs,
  );
  const resolvedUrl = resolveStringValue(step.request.url, context);
  const resolvedHeaders = resolveHeaders(step, context);
  const authHeaders = resolveAuthHeaders(step, context);
  const headers = mergeStringRecords(
    resolvedHeaders.headers,
    authHeaders.headers,
  );

  const body = await resolveRequestBody(projectRoot, step, context);
  if (body?.body.contentType && !hasContentTypeHeader(headers)) {
    headers["content-type"] = body.body.contentType;
  }

  return {
    request: {
      requestId: step.requestId,
      stepId: step.id,
      method: step.request.method,
      url: resolvedUrl.value,
      headers,
      body: body?.body,
      timeoutMs: resolveTimeoutMs(step, compiled),
      secretValues: uniqueSecretValues([
        ...resolvedUrl.secretValues,
        ...resolvedHeaders.secretValues,
        ...authHeaders.secretValues,
        ...(body?.secretValues ?? []),
      ]),
    },
    variables: collectVariableExplanations(context),
  };
}

async function createRequestResolutionContext(
  projectRoot: string,
  compiled: CompiledRunSnapshot,
  step: CompiledRequestStep,
  stepOutputs: Record<string, Record<string, FlatVariableValue>>,
  secretStepOutputs: Record<string, string[]>,
): Promise<RequestResolutionContext> {
  return {
    projectRoot,
    compiled,
    step,
    stepOutputs,
    secretStepOutputs,
    secrets: await loadSecrets(projectRoot),
    processEnv: process.env,
  };
}

function resolveHeaders(
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): {
  headers: Record<string, string>;
  secretValues: string[];
} {
  const mergedHeaders = mergeStringRecords(
    ...step.request.headerBlocks.map((headerBlock) => headerBlock.headers),
    step.request.headers,
  );

  return Object.entries(mergedHeaders).reduce<{
    headers: Record<string, string>;
    secretValues: string[];
  }>(
    (result, [name, value]) => {
      const resolvedHeader = resolveStringValue(value, context);
      result.headers[name] = resolvedHeader.value;
      result.secretValues.push(...resolvedHeader.secretValues);
      return result;
    },
    {
      headers: {},
      secretValues: [],
    },
  );
}

function resolveAuthHeaders(
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): {
  headers: Record<string, string>;
  secretValues: string[];
} {
  const auth = step.request.auth ?? step.request.authBlock?.auth;
  if (!auth) {
    return {
      headers: {},
      secretValues: [],
    };
  }

  if (auth.scheme === "bearer") {
    const resolvedToken = resolveStringValue(auth.token, context);
    return {
      headers: {
        authorization: `Bearer ${resolvedToken.value}`,
      },
      secretValues: resolvedToken.secretValues,
    };
  }

  if (auth.scheme === "basic") {
    const resolvedUsername = resolveStringValue(auth.username, context);
    const resolvedPassword = resolveStringValue(auth.password, context);
    const encoded = Buffer.from(
      `${resolvedUsername.value}:${resolvedPassword.value}`,
      "utf8",
    ).toString("base64");
    return {
      headers: {
        authorization: `Basic ${encoded}`,
      },
      secretValues: uniqueSecretValues([
        ...resolvedUsername.secretValues,
        ...resolvedPassword.secretValues,
      ]),
    };
  }

  const resolvedHeaderName = resolveStringValue(auth.header, context);
  const resolvedHeaderValue = resolveStringValue(auth.value, context);
  return {
    headers: {
      [resolvedHeaderName.value]: resolvedHeaderValue.value,
    },
    secretValues: uniqueSecretValues([
      ...resolvedHeaderName.secretValues,
      ...resolvedHeaderValue.secretValues,
    ]),
  };
}

function resolveTimeoutMs(
  step: CompiledRequestStep,
  compiled: CompiledRunSnapshot,
): number {
  const timeoutValue =
    step.request.timeoutMs ??
    resolveOptionalNumberValue(step.request.defaults.timeoutMs) ??
    resolveOptionalNumberValue(compiled.runInputs.timeoutMs) ??
    resolveOptionalNumberValue(compiled.envValues.timeoutMs) ??
    resolveOptionalNumberValue(compiled.configDefaults.timeoutMs) ??
    10_000;

  return validateTimeoutMs(step.id, step.requestId, timeoutValue);
}

function hasContentTypeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(
    (headerName) => normalizeHeaderName(headerName) === "content-type",
  );
}

function resolveOptionalNumberValue(
  value: FlatVariableValue | undefined,
): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function validateTimeoutMs(
  stepId: string,
  requestId: string,
  timeoutMs: number,
): number {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  throw new HttpiError(
    "REQUEST_TIMEOUT_INVALID",
    `Request ${requestId} step ${stepId} resolved an invalid timeoutMs value (${timeoutMs}). timeoutMs must be a positive number.`,
    { exitCode: exitCodes.validationFailure },
  );
}

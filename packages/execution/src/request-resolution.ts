import { Buffer } from "node:buffer";
import type {
  CompiledRequestStep,
  CompiledRunSnapshot,
  FlatVariableValue,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
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

interface TimeoutResolutionSource {
  value: FlatVariableValue | undefined;
  filePath?: string | undefined;
  path?: string | undefined;
}

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
  const resolvedUrl = resolveStringValue(step.request.url, context, {
    filePath: step.request.filePath,
    path: "url",
  });
  const resolvedHeaders = resolveHeaders(step, context);
  const authHeaders = await resolveAuthHeaders(step, context);
  const headers = mergeStringRecords(
    resolvedHeaders.headers,
    authHeaders.headers,
  );

  const body = await resolveRequestBody(projectRoot, step, context);
  if (body?.body.contentType && !hasContentTypeHeader(headers)) {
    headers["content-type"] = body.body.contentType;
  }

  // Inject idempotency header (C1)
  const idempotencySecrets: string[] = [];
  if (step.idempotency) {
    const resolvedIdempValue = resolveStringValue(
      step.idempotency.value,
      context,
      { filePath: step.request.filePath, path: "idempotency.value" },
    );
    headers[normalizeHeaderName(step.idempotency.header)] =
      resolvedIdempValue.value;
    idempotencySecrets.push(...resolvedIdempValue.secretValues);
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
        ...idempotencySecrets,
      ]),
      responseMode: step.request.response?.mode,
      streamConfig: step.request.response?.stream,
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
  const resolvedHeaderSources = [
    ...step.request.headerBlocks.map((headerBlock) =>
      resolveHeaderMap(headerBlock.headers, headerBlock.filePath, context),
    ),
    resolveHeaderMap(step.request.headers, step.request.filePath, context),
  ];

  return {
    headers: mergeStringRecords(
      ...resolvedHeaderSources.map(
        (resolvedHeaders) => resolvedHeaders.headers,
      ),
    ),
    secretValues: uniqueSecretValues(
      resolvedHeaderSources.flatMap(
        (resolvedHeaders) => resolvedHeaders.secretValues,
      ),
    ),
  };
}

async function resolveAuthHeaders(
  step: CompiledRequestStep,
  context: RequestResolutionContext,
): Promise<{
  headers: Record<string, string>;
  secretValues: string[];
}> {
  const auth = step.request.auth ?? step.request.authBlock?.auth;
  if (!auth) {
    return {
      headers: {},
      secretValues: [],
    };
  }

  const authFilePath =
    step.request.authBlock?.filePath ?? step.request.filePath;

  if (auth.scheme === "bearer") {
    const resolvedToken = resolveStringValue(auth.token, context, {
      filePath: authFilePath,
      path: "auth.token",
    });
    return {
      headers: {
        authorization: `Bearer ${resolvedToken.value}`,
      },
      secretValues: resolvedToken.secretValues,
    };
  }

  if (auth.scheme === "basic") {
    const resolvedUsername = resolveStringValue(auth.username, context, {
      filePath: authFilePath,
      path: "auth.username",
    });
    const resolvedPassword = resolveStringValue(auth.password, context, {
      filePath: authFilePath,
      path: "auth.password",
    });
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

  if (auth.scheme === "header") {
    const resolvedHeaderName = resolveStringValue(auth.header, context, {
      filePath: authFilePath,
      path: "auth.header",
    });
    const resolvedHeaderValue = resolveStringValue(auth.value, context, {
      filePath: authFilePath,
      path: "auth.value",
    });
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

  if (auth.scheme === "oauth2-client-credentials") {
    const resolvedTokenUrl = resolveStringValue(auth.tokenUrl, context, {
      filePath: authFilePath,
      path: "auth.tokenUrl",
    });
    const resolvedClientId = resolveStringValue(auth.clientId, context, {
      filePath: authFilePath,
      path: "auth.clientId",
    });
    const resolvedClientSecret = resolveStringValue(
      auth.clientSecret,
      context,
      {
        filePath: authFilePath,
        path: "auth.clientSecret",
      },
    );

    // Token fetch happens at execution time via the OAuth2 token cache
    // For now, store credentials as a bearer placeholder that will be resolved
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: resolvedClientId.value,
      client_secret: resolvedClientSecret.value,
      ...(auth.scope ? { scope: auth.scope.join(" ") } : {}),
    });

    try {
      const tokenResponse = await fetch(resolvedTokenUrl.value, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
        signal: AbortSignal.timeout(30000),
      });
      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse
          .text()
          .catch(() => "<unreadable>");
        throw new HttpiError(
          "OAUTH2_TOKEN_FAILED",
          `OAuth2 token endpoint returned HTTP ${tokenResponse.status}: ${errorBody.slice(0, 200)}`,
          { exitCode: exitCodes.executionFailure },
        );
      }
      const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
      const accessToken =
        typeof tokenData.access_token === "string"
          ? tokenData.access_token
          : undefined;
      if (!accessToken) {
        throw new HttpiError(
          "OAUTH2_TOKEN_FAILED",
          "OAuth2 token endpoint returned no access_token.",
          { exitCode: exitCodes.executionFailure },
        );
      }
      return {
        headers: { authorization: `Bearer ${accessToken}` },
        secretValues: uniqueSecretValues([
          ...resolvedClientId.secretValues,
          ...resolvedClientSecret.secretValues,
          accessToken,
        ]),
      };
    } catch (error) {
      if (error instanceof HttpiError) throw error;
      throw new HttpiError(
        "OAUTH2_TOKEN_FAILED",
        `OAuth2 token request failed: ${error instanceof Error ? error.message : String(error)}`,
        { exitCode: exitCodes.executionFailure, cause: error },
      );
    }
  }

  if (auth.scheme === "hmac") {
    const { createHmac } = await import("node:crypto");
    const resolvedSecret = resolveStringValue(auth.secret, context, {
      filePath: authFilePath,
      path: "auth.secret",
    });
    const resolvedSign = resolveStringValue(auth.sign, context, {
      filePath: authFilePath,
      path: "auth.sign",
    });

    const signature = createHmac(auth.algorithm, resolvedSecret.value)
      .update(resolvedSign.value)
      .digest("hex");

    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {};
    if (auth.headers) {
      for (const [key, value] of Object.entries(auth.headers)) {
        const resolved = resolveStringValue(
          value.replace("{sig}", signature).replace("{timestamp}", timestamp),
          context,
          { filePath: authFilePath, path: `auth.headers.${key}` },
        );
        headers[key] = resolved.value;
      }
    } else {
      // Default: inject Authorization header with HMAC signature
      const keyPrefix = auth.keyId ? `keyId="${auth.keyId}", ` : "";
      headers.authorization = `HMAC-${auth.algorithm.toUpperCase()} ${keyPrefix}signature="${signature}"`;
    }

    return {
      headers,
      secretValues: uniqueSecretValues([
        ...resolvedSecret.secretValues,
        signature,
      ]),
    };
  }

  return { headers: {}, secretValues: [] };
}

function resolveTimeoutMs(
  step: CompiledRequestStep,
  compiled: CompiledRunSnapshot,
): number {
  const timeoutSource = resolveTimeoutSource(step, compiled);
  return validateTimeoutMs(step.id, step.requestId, timeoutSource);
}

function hasContentTypeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(
    (headerName) => normalizeHeaderName(headerName) === "content-type",
  );
}

function validateTimeoutMs(
  stepId: string,
  requestId: string,
  timeoutSource: TimeoutResolutionSource,
): number {
  const timeoutMs = timeoutSource.value;
  if (
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  ) {
    return timeoutMs;
  }

  const message = `Request ${requestId} step ${stepId} resolved an invalid timeoutMs value (${timeoutMs}). timeoutMs must be a positive number.`;
  throw new HttpiError("REQUEST_TIMEOUT_INVALID", message, {
    exitCode: exitCodes.validationFailure,
    details: timeoutSource.filePath
      ? [
          {
            level: "error" as const,
            code: "REQUEST_TIMEOUT_INVALID",
            message,
            filePath: timeoutSource.filePath,
            ...(timeoutSource.path ? { path: timeoutSource.path } : {}),
          },
        ]
      : undefined,
  });
}

function resolveTimeoutSource(
  step: CompiledRequestStep,
  compiled: CompiledRunSnapshot,
): TimeoutResolutionSource {
  const overrideKeys = new Set(compiled.overrideKeys ?? []);
  const sources: TimeoutResolutionSource[] = [
    {
      value: step.request.timeoutMs ?? undefined,
      filePath: step.request.filePath,
      path: "timeoutMs",
    },
    {
      value: step.request.defaults.timeoutMs ?? undefined,
      filePath: step.request.filePath,
      path: appendDiagnosticPath("defaults", "timeoutMs"),
    },
    overrideKeys.has("timeoutMs")
      ? {
          value: compiled.runInputs.timeoutMs ?? undefined,
          filePath: "<input>",
          path: "timeoutMs",
        }
      : {
          value: compiled.runInputs.timeoutMs ?? undefined,
          filePath:
            compiled.source === "run" ? compiled.sourceFilePath : undefined,
          path:
            compiled.source === "run"
              ? appendDiagnosticPath("inputs", "timeoutMs")
              : undefined,
        },
    {
      value: compiled.envValues.timeoutMs ?? undefined,
      filePath: compiled.envPath,
      path: appendDiagnosticPath("values", "timeoutMs"),
    },
    {
      value: compiled.configDefaults.timeoutMs ?? undefined,
      filePath: compiled.configPath,
      path: appendDiagnosticPath("defaults", "timeoutMs"),
    },
  ];

  const resolvedSource = sources.find((source) => source.value !== undefined);
  return resolvedSource ?? { value: 10_000 };
}

function resolveHeaderMap(
  headers: Record<string, string>,
  filePath: string,
  context: RequestResolutionContext,
): {
  headers: Record<string, string>;
  secretValues: string[];
} {
  return Object.entries(headers).reduce<{
    headers: Record<string, string>;
    secretValues: string[];
  }>(
    (result, [name, value]) => {
      const resolvedHeader = resolveStringValue(value, context, {
        filePath,
        path: appendDiagnosticPath("headers", name),
      });
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

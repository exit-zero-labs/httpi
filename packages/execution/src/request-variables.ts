import type {
  FlatVariableValue,
  VariableExplanation,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
import {
  exitCodes,
  HttpiError,
  interpolateTemplate,
  looksLikeSecretFieldName,
} from "@exit-zero-labs/httpi-shared";
import { uniqueSecretValues } from "./request-secrets.js";
import type { RequestResolutionContext, ResolvedScalarValue } from "./types.js";

interface TemplateValueResolution {
  value: FlatVariableValue;
  secretValues: string[];
}

interface StringValueResolution {
  value: string;
  secretValues: string[];
}

interface ResolutionDiagnosticLocation {
  filePath?: string | undefined;
  path?: string | undefined;
}

export function resolveStringValue(
  value: string,
  context: RequestResolutionContext,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): StringValueResolution {
  const resolved = resolveTemplateValue(value, context, diagnosticLocation);
  return {
    value: String(resolved.value),
    secretValues: resolved.secretValues,
  };
}

export function resolveTemplateValue(
  value: string,
  context: RequestResolutionContext,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): TemplateValueResolution {
  if (value.startsWith("$ENV:")) {
    const environmentValue = readProcessEnvValue(
      value.slice("$ENV:".length),
      context,
      diagnosticLocation,
    );
    return {
      value: environmentValue,
      secretValues: [environmentValue],
    };
  }

  const exactToken = matchExactToken(value);
  if (exactToken) {
    const resolvedValue = requireResolvedToken(
      exactToken,
      context,
      new Set(),
      diagnosticLocation,
    );
    return {
      value: resolvedValue.value,
      secretValues: resolvedValue.secretValues,
    };
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedValue = resolveToken(
      token,
      context,
      new Set(),
      diagnosticLocation,
    );
    if (!resolvedValue) {
      return undefined;
    }

    return resolvedValue.value === null ? "null" : String(resolvedValue.value);
  });
  assertNoUnresolvedTokens(interpolation.unresolved, diagnosticLocation);

  return {
    value: interpolation.value,
    secretValues: uniqueSecretValues(
      interpolation.tokens.flatMap(
        (token) =>
          resolveToken(
            token,
            context,
            new Set(),
            diagnosticLocation,
          )?.secretValues ?? [],
      ),
    ),
  };
}

export function collectVariableExplanations(
  context: RequestResolutionContext,
): VariableExplanation[] {
  const keys = new Set<string>();
  for (const sourceValues of [
    context.compiled.configDefaults,
    context.compiled.envValues,
    context.step.request.defaults,
    context.compiled.runInputs,
    context.step.with,
  ]) {
    for (const key of Object.keys(sourceValues)) {
      keys.add(key);
    }
  }

  const explanations = [...keys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => {
      const resolved = resolveToken(
        key,
        context,
        new Set(),
        getVariableDiagnosticLocation(key, context),
      );
      return {
        name: key,
        value: resolved?.value,
        source: resolved?.source ?? "config",
        secret: resolved?.secret,
      };
    });

  const stepOutputExplanations = Object.entries(context.stepOutputs).flatMap(
    ([stepId, values]) =>
      Object.entries(values).map(([fieldName, value]) => ({
        name: `steps.${stepId}.${fieldName}`,
        value,
        source: "step" as const,
        secret:
          context.secretStepOutputs[stepId]?.includes(fieldName) ??
          looksLikeSecretFieldName(fieldName),
      })),
  );

  return [...explanations, ...stepOutputExplanations];
}

function requireResolvedToken(
  token: string,
  context: RequestResolutionContext,
  seenTokens: Set<string>,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): ResolvedScalarValue {
  const resolvedValue = resolveToken(
    token,
    context,
    seenTokens,
    diagnosticLocation,
  );
  if (resolvedValue) {
    return resolvedValue;
  }

  throw buildResolutionError(
    "VARIABLE_UNRESOLVED",
    `Unable to resolve ${token}.`,
    diagnosticLocation,
    "Define the referenced variable or update the template at this location.",
  );
}

function resolveToken(
  token: string,
  context: RequestResolutionContext,
  seenTokens: Set<string>,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): ResolvedScalarValue | undefined {
  const trimmedToken = token.trim();

  if (trimmedToken.startsWith("steps.")) {
    return resolveStepReference(trimmedToken, context);
  }

  if (trimmedToken.startsWith("secrets.")) {
    const alias = trimmedToken.slice("secrets.".length);
    const secretValue = context.secrets[alias];
    if (secretValue === undefined) {
      return undefined;
    }

    return {
      value: secretValue,
      source: "secret",
      secret: true,
      secretValues: [secretValue],
    };
  }

  if (seenTokens.has(trimmedToken)) {
    throw buildResolutionError(
      "VARIABLE_CYCLE",
      `Detected a variable cycle while resolving ${trimmedToken}.`,
      diagnosticLocation,
      "Break the cycle by removing the self-referential template chain at this location.",
    );
  }

  const nextSeenTokens = new Set(seenTokens);
  nextSeenTokens.add(trimmedToken);

  const variableSources = [
    {
      source:
        context.compiled.source === "request"
          ? ("override" as const)
          : ("step" as const),
      values: context.step.with,
    },
    {
      source:
        context.compiled.source === "request"
          ? ("override" as const)
          : ("run" as const),
      values: context.compiled.runInputs,
    },
    {
      source: "request" as const,
      values: context.step.request.defaults,
    },
    {
      source: "env" as const,
      values: context.compiled.envValues,
    },
    {
      source: "config" as const,
      values: context.compiled.configDefaults,
    },
  ];

  for (const variableSource of variableSources) {
    if (!(trimmedToken in variableSource.values)) {
      continue;
    }

    const rawValue = variableSource.values[trimmedToken];
    if (rawValue === undefined) {
      continue;
    }

    return resolveScalarValue(
      rawValue,
      resolveVariableSource(trimmedToken, variableSource.source, context),
      context,
      nextSeenTokens,
      diagnosticLocation,
    );
  }

  return undefined;
}

function resolveStepReference(
  token: string,
  context: RequestResolutionContext,
): ResolvedScalarValue | undefined {
  const match = token.match(/^steps\.([^.]+)\.(.+)$/);
  if (!match) {
    return undefined;
  }

  const stepId = match[1];
  const fieldName = match[2];
  if (!stepId || !fieldName) {
    return undefined;
  }

  const stepOutput = context.stepOutputs[stepId];
  if (!stepOutput || !(fieldName in stepOutput)) {
    return undefined;
  }

  const fieldValue = stepOutput[fieldName];
  if (fieldValue === undefined) {
    return undefined;
  }

  const secret =
    context.secretStepOutputs[stepId]?.includes(fieldName) ??
    looksLikeSecretFieldName(fieldName);

  return {
    value: fieldValue,
    source: "step",
    secret,
    secretValues: secret
      ? [fieldValue === null ? "null" : String(fieldValue)]
      : [],
  };
}

function resolveScalarValue(
  value: FlatVariableValue,
  source: VariableExplanation["source"],
  context: RequestResolutionContext,
  seenTokens: Set<string>,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): ResolvedScalarValue {
  if (typeof value !== "string") {
    return applyOverrideSecretTaint({
      value,
      source,
      secret: false,
      secretValues: [],
    });
  }

  if (value.startsWith("$ENV:")) {
    const environmentValue = readProcessEnvValue(
      value.slice("$ENV:".length),
      context,
      diagnosticLocation,
    );
    return {
      value: environmentValue,
      source: "process-env",
      secret: true,
      secretValues: [environmentValue],
    };
  }

  const exactToken = matchExactToken(value);
  if (exactToken) {
    return applyOverrideSecretTaint(
      requireResolvedToken(
        exactToken,
        context,
        seenTokens,
        diagnosticLocation,
      ),
    );
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedToken = resolveToken(
      token,
      context,
      seenTokens,
      diagnosticLocation,
    );
    if (!resolvedToken) {
      return undefined;
    }

      return resolvedToken.value === null ? "null" : String(resolvedToken.value);
  });
  assertNoUnresolvedTokens(interpolation.unresolved, diagnosticLocation);

  return applyOverrideSecretTaint({
    value: interpolation.value,
    source,
    secret: interpolation.tokens.some(
      (token) =>
        resolveToken(token, context, seenTokens, diagnosticLocation)?.secret ??
        false,
    ),
    secretValues: uniqueSecretValues(
      interpolation.tokens.flatMap(
        (token) =>
          resolveToken(
            token,
            context,
            seenTokens,
            diagnosticLocation,
          )?.secretValues ?? [],
      ),
    ),
  });
}

function readProcessEnvValue(
  environmentName: string,
  context: RequestResolutionContext,
  diagnosticLocation?: ResolutionDiagnosticLocation,
): string {
  const environmentValue = context.processEnv[environmentName];
  if (environmentValue !== undefined) {
    return environmentValue;
  }

  throw buildResolutionError(
    "PROCESS_ENV_MISSING",
    `Environment variable ${environmentName} is required but missing.`,
    diagnosticLocation,
    "Set the missing environment variable or replace the $ENV reference at this location.",
  );
}

function matchExactToken(value: string): string | undefined {
  return value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1];
}

function assertNoUnresolvedTokens(
  unresolved: string[],
  diagnosticLocation?: ResolutionDiagnosticLocation,
): void {
  if (unresolved.length === 0) {
    return;
  }

  throw buildResolutionError(
    "VARIABLE_UNRESOLVED",
    `Unable to resolve ${unresolved.join(", ")}.`,
    diagnosticLocation,
    "Define the referenced variable or update the template at this location.",
  );
}

function resolveVariableSource(
  token: string,
  source: VariableExplanation["source"],
  context: RequestResolutionContext,
): VariableExplanation["source"] {
  if (source !== "run") {
    return source;
  }

  return (context.compiled.overrideKeys ?? []).includes(token)
    ? "override"
    : source;
}

function getVariableDiagnosticLocation(
  key: string,
  context: RequestResolutionContext,
): ResolutionDiagnosticLocation | undefined {
  if (key in context.step.with) {
    if (context.compiled.source === "request") {
      return {
        filePath: "<input>",
        path: key,
      };
    }

    return {
      filePath: context.compiled.sourceFilePath,
      path: appendDiagnosticPath(
        appendDiagnosticPath(
          appendDiagnosticPath("steps", context.step.id),
          "with",
        ),
        key,
      ),
    };
  }

  if (key in context.compiled.runInputs) {
    if ((context.compiled.overrideKeys ?? []).includes(key)) {
      return {
        filePath: "<input>",
        path: key,
      };
    }

    return {
      filePath: context.compiled.sourceFilePath,
      path: appendDiagnosticPath("inputs", key),
    };
  }

  if (key in context.step.request.defaults) {
    return {
      filePath: context.step.request.filePath,
      path: appendDiagnosticPath("defaults", key),
    };
  }

  if (key in context.compiled.envValues) {
    return {
      filePath: context.compiled.envPath,
      path: appendDiagnosticPath("values", key),
    };
  }

  if (key in context.compiled.configDefaults) {
    return {
      filePath: context.compiled.configPath,
      path: appendDiagnosticPath("defaults", key),
    };
  }

  return undefined;
}

function applyOverrideSecretTaint(
  resolvedValue: ResolvedScalarValue,
): ResolvedScalarValue {
  if (resolvedValue.source !== "override") {
    return resolvedValue;
  }

  const serializedValue =
    resolvedValue.value === null ? "null" : String(resolvedValue.value);
  return {
    ...resolvedValue,
    secret: true,
    secretValues: uniqueSecretValues([
      ...resolvedValue.secretValues,
      serializedValue,
    ]),
  };
}

function buildResolutionError(
  code: string,
  message: string,
  diagnosticLocation: ResolutionDiagnosticLocation | undefined,
  hint: string,
): HttpiError {
  return new HttpiError(code, message, {
    exitCode: exitCodes.validationFailure,
    ...(diagnosticLocation
      ? {
          details: [
            {
              level: "error" as const,
              code,
              message,
              hint,
              ...(diagnosticLocation.filePath
                ? { filePath: diagnosticLocation.filePath }
                : {}),
              ...(diagnosticLocation.path
                ? { path: diagnosticLocation.path }
                : {}),
            },
          ],
        }
      : {}),
  });
}

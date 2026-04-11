import type {
  FlatVariableValue,
  VariableExplanation,
} from "@exit-zero-labs/httpi-contracts";
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

export function resolveStringValue(
  value: string,
  context: RequestResolutionContext,
): StringValueResolution {
  const resolved = resolveTemplateValue(value, context);
  return {
    value: String(resolved.value),
    secretValues: resolved.secretValues,
  };
}

export function resolveTemplateValue(
  value: string,
  context: RequestResolutionContext,
): TemplateValueResolution {
  if (value.startsWith("$ENV:")) {
    const environmentValue = readProcessEnvValue(
      value.slice("$ENV:".length),
      context,
    );
    return {
      value: environmentValue,
      secretValues: [environmentValue],
    };
  }

  const exactToken = matchExactToken(value);
  if (exactToken) {
    const resolvedValue = requireResolvedToken(exactToken, context, new Set());
    return {
      value: resolvedValue.value,
      secretValues: resolvedValue.secretValues,
    };
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedValue = resolveToken(token, context, new Set());
    if (!resolvedValue) {
      return undefined;
    }

    return resolvedValue.value === null ? "null" : String(resolvedValue.value);
  });
  assertNoUnresolvedTokens(interpolation.unresolved);

  return {
    value: interpolation.value,
    secretValues: uniqueSecretValues(
      interpolation.tokens.flatMap(
        (token) => resolveToken(token, context, new Set())?.secretValues ?? [],
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
      const resolved = resolveToken(key, context, new Set());
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
): ResolvedScalarValue {
  const resolvedValue = resolveToken(token, context, seenTokens);
  if (resolvedValue) {
    return resolvedValue;
  }

  throw new HttpiError("VARIABLE_UNRESOLVED", `Unable to resolve ${token}.`, {
    exitCode: exitCodes.validationFailure,
  });
}

function resolveToken(
  token: string,
  context: RequestResolutionContext,
  seenTokens: Set<string>,
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
    throw new HttpiError(
      "VARIABLE_CYCLE",
      `Detected a variable cycle while resolving ${trimmedToken}.`,
      { exitCode: exitCodes.validationFailure },
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
      requireResolvedToken(exactToken, context, seenTokens),
    );
  }

  const interpolation = interpolateTemplate(value, (token) => {
    const resolvedToken = resolveToken(token, context, seenTokens);
    if (!resolvedToken) {
      return undefined;
    }

    return resolvedToken.value === null ? "null" : String(resolvedToken.value);
  });
  assertNoUnresolvedTokens(interpolation.unresolved);

  return applyOverrideSecretTaint({
    value: interpolation.value,
    source,
    secret: interpolation.tokens.some(
      (token) => resolveToken(token, context, seenTokens)?.secret ?? false,
    ),
    secretValues: uniqueSecretValues(
      interpolation.tokens.flatMap(
        (token) => resolveToken(token, context, seenTokens)?.secretValues ?? [],
      ),
    ),
  });
}

function readProcessEnvValue(
  environmentName: string,
  context: RequestResolutionContext,
): string {
  const environmentValue = context.processEnv[environmentName];
  if (environmentValue !== undefined) {
    return environmentValue;
  }

  throw new HttpiError(
    "PROCESS_ENV_MISSING",
    `Environment variable ${environmentName} is required but missing.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function matchExactToken(value: string): string | undefined {
  return value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1];
}

function assertNoUnresolvedTokens(unresolved: string[]): void {
  if (unresolved.length === 0) {
    return;
  }

  throw new HttpiError(
    "VARIABLE_UNRESOLVED",
    `Unable to resolve ${unresolved.join(", ")}.`,
    { exitCode: exitCodes.validationFailure },
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

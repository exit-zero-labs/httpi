import type {
  CompiledRunSnapshot,
  FlatVariableMap,
  ResolvedRequestModel,
  SessionRecord,
  VariableExplanation,
} from "@exit-zero-labs/httpi-contracts";
import {
  looksLikeSecretFieldName,
  redactedValue,
  redactHeaders,
  redactText,
} from "@exit-zero-labs/httpi-shared";

export function redactResolvedRequestModel(
  request: ResolvedRequestModel,
): ResolvedRequestModel {
  return {
    ...request,
    url: redactText(request.url, request.secretValues),
    headers: redactHeaders(request.headers, [], request.secretValues),
    body:
      request.body?.text !== undefined
        ? {
            ...request.body,
            text: redactText(request.body.text, request.secretValues),
          }
        : request.body,
    secretValues: [],
  };
}

export function redactVariableExplanations(
  variables: VariableExplanation[],
): VariableExplanation[] {
  return variables.map((variable) =>
    variable.secret ? { ...variable, value: redactedValue } : variable,
  );
}

function redactFlatVariableMap(
  values: FlatVariableMap,
  secretKeys: Iterable<string> = [],
): FlatVariableMap {
  const secretKeySet = new Set(secretKeys);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      secretKeySet.has(key) || looksLikeSecretFieldName(key)
        ? redactedValue
        : value,
    ]),
  );
}

export function redactSessionForOutput(session: SessionRecord): SessionRecord {
  return {
    ...session,
    compiled: {
      ...session.compiled,
      configDefaults: redactFlatVariableMap(session.compiled.configDefaults),
      envValues: redactFlatVariableMap(session.compiled.envValues),
      runInputs: redactFlatVariableMap(
        session.compiled.runInputs,
        session.compiled.overrideKeys,
      ),
      steps: session.compiled.steps.map((step) =>
        redactCompiledStep(
          step,
          session.compiled.source === "request"
            ? session.compiled.overrideKeys
            : [],
        ),
      ),
    },
    stepRecords: Object.fromEntries(
      Object.entries(session.stepRecords).map(([stepId, stepRecord]) => [
        stepId,
        {
          ...stepRecord,
          output: redactFlatVariableMap(
            stepRecord.output,
            stepRecord.secretOutputKeys ?? [],
          ),
        },
      ]),
    ),
    stepOutputs: Object.fromEntries(
      Object.entries(session.stepOutputs).map(([stepId, values]) => [
        stepId,
        redactFlatVariableMap(
          values,
          session.stepRecords[stepId]?.secretOutputKeys ?? [],
        ),
      ]),
    ),
  };
}

function redactCompiledStep(
  step: CompiledRunSnapshot["steps"][number],
  secretWithKeys: Iterable<string> = [],
): CompiledRunSnapshot["steps"][number] {
  if (step.kind === "parallel") {
    return {
      ...step,
      steps: step.steps.map((childStep) => ({
        ...childStep,
        with: redactFlatVariableMap(childStep.with),
        request: {
          ...childStep.request,
          defaults: redactFlatVariableMap(childStep.request.defaults),
        },
      })),
    };
  }

  if (step.kind === "pause") {
    return step;
  }

  if (step.kind === "pollUntil") {
    return {
      ...step,
      requestStep: {
        ...step.requestStep,
        with: redactFlatVariableMap(step.requestStep.with, secretWithKeys),
        request: {
          ...step.requestStep.request,
          defaults: redactFlatVariableMap(step.requestStep.request.defaults),
        },
      },
    };
  }

  return {
    ...step,
    with: redactFlatVariableMap(step.with, secretWithKeys),
    request: {
      ...step.request,
      defaults: redactFlatVariableMap(step.request.defaults),
    },
  };
}

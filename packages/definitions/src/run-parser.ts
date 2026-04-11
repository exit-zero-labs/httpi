import type {
  Diagnostic,
  RunDefinition,
  RunParallelStepDefinition,
  RunPauseStepDefinition,
  RunRequestStepDefinition,
  RunStepDefinition,
} from "@exit-zero-labs/httpi-contracts";
import { asRecord } from "@exit-zero-labs/httpi-shared";
import {
  expectRecord,
  readLiteral,
  readOptionalFlatVariableMap,
  readOptionalString,
  readRequiredString,
} from "./parsing-helpers.js";

export function parseRunDefinition(
  value: unknown,
  filePath: string,
): {
  value?: RunDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "run");
  if (!record) {
    return { diagnostics };
  }

  const kind = readLiteral(record, "kind", "run", filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const env = readOptionalString(record, "env", filePath, diagnostics);
  const inputs = readOptionalFlatVariableMap(
    record.inputs,
    filePath,
    diagnostics,
    "inputs",
  );
  const steps = parseRunSteps(record.steps, filePath, diagnostics);

  if (!kind) {
    return { diagnostics };
  }

  return {
    value: {
      kind,
      title,
      env,
      inputs,
      steps,
    },
    diagnostics,
    title,
  };
}

function parseRunSteps(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RunStepDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_STEPS",
      message: "Run definitions require a steps array.",
      filePath,
      path: "steps",
    });
    return [];
  }

  return value.reduce<RunStepDefinition[]>((steps, entry, index) => {
    const stepRecord = asRecord(entry);
    if (!stepRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Each step must be an object.",
        filePath,
        path: `steps[${index}]`,
      });
      return steps;
    }

    const kind = readRequiredString(
      stepRecord,
      "kind",
      filePath,
      diagnostics,
      "Each step requires a string kind.",
    );
    if (!kind) {
      return steps;
    }

    if (kind === "request") {
      const requestStep = parseRunRequestStep(
        stepRecord,
        filePath,
        diagnostics,
      );
      if (requestStep) {
        steps.push(requestStep);
      }
      return steps;
    }

    if (kind === "pause") {
      const pauseStep = parseRunPauseStep(stepRecord, filePath, diagnostics);
      if (pauseStep) {
        steps.push(pauseStep);
      }
      return steps;
    }

    if (kind === "parallel") {
      const parallelStep = parseRunParallelStep(
        stepRecord,
        filePath,
        diagnostics,
      );
      if (parallelStep) {
        steps.push(parallelStep);
      }
      return steps;
    }

    diagnostics.push({
      level: "error",
      code: "INVALID_STEP_KIND",
      message: `Unsupported run step kind ${kind}.`,
      filePath,
      path: `steps[${index}].kind`,
    });
    return steps;
  }, []);
}

function parseRunRequestStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunRequestStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Request steps require a string id.",
  );
  const uses = readRequiredString(
    record,
    "uses",
    filePath,
    diagnostics,
    "Request steps require a string uses reference.",
  );
  const withValues = readOptionalFlatVariableMap(
    record.with,
    filePath,
    diagnostics,
    "with",
  );

  if (!id || !uses) {
    return undefined;
  }

  return {
    kind: "request",
    id,
    uses,
    with: withValues,
  };
}

function parseRunPauseStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunPauseStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Pause steps require a string id.",
  );
  const reason = readRequiredString(
    record,
    "reason",
    filePath,
    diagnostics,
    "Pause steps require a string reason.",
  );

  if (!id || !reason) {
    return undefined;
  }

  return {
    kind: "pause",
    id,
    reason,
  };
}

function parseRunParallelStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunParallelStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Parallel steps require a string id.",
  );
  const stepsValue = record.steps;
  if (!Array.isArray(stepsValue)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_PARALLEL_STEPS",
      message: "Parallel steps require a steps array.",
      filePath,
      path: "steps",
    });
    return undefined;
  }

  const steps = stepsValue.flatMap((entry, index) => {
    const childRecord = asRecord(entry);
    if (!childRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Parallel child steps must be objects.",
        filePath,
        path: `steps.${id}.steps[${index}]`,
      });
      return [];
    }

    const kind = readRequiredString(
      childRecord,
      "kind",
      filePath,
      diagnostics,
      "Parallel child steps require a string kind.",
    );
    if (kind !== "request") {
      diagnostics.push({
        level: "error",
        code: "INVALID_PARALLEL_CHILD_KIND",
        message: "Only request steps are allowed inside parallel groups in v0.",
        filePath,
        path: `steps.${id}.steps[${index}].kind`,
      });
      return [];
    }

    const requestStep = parseRunRequestStep(childRecord, filePath, diagnostics);
    return requestStep ? [requestStep] : [];
  });

  if (!id) {
    return undefined;
  }

  return {
    kind: "parallel",
    id,
    steps,
  };
}

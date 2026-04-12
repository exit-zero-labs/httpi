import type {
  Diagnostic,
  IdempotencyConfig,
  RetryPolicy,
  RunDefinition,
  RunParallelStepDefinition,
  RunPauseStepDefinition,
  RunPollUntilStepDefinition,
  RunRequestStepDefinition,
  RunStepDefinition,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
import { asRecord } from "@exit-zero-labs/httpi-shared";
import {
  expectRecord,
  isJsonValue,
  readLiteral,
  readOptionalFlatVariableMap,
  readOptionalNumber,
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
    const stepPath = appendDiagnosticPath("steps", index);
    const stepRecord = asRecord(entry);
    if (!stepRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Each step must be an object.",
        filePath,
        path: stepPath,
      });
      return steps;
    }

    const kind = readRequiredString(
      stepRecord,
      "kind",
      filePath,
      diagnostics,
      "Each step requires a string kind.",
      stepPath,
    );
    if (!kind) {
      return steps;
    }

    if (kind === "request") {
      const requestStep = parseRunRequestStep(
        stepRecord,
        filePath,
        diagnostics,
        stepPath,
      );
      if (requestStep) {
        steps.push(requestStep);
      }
      return steps;
    }

    if (kind === "pause") {
      const pauseStep = parseRunPauseStep(
        stepRecord,
        filePath,
        diagnostics,
        stepPath,
      );
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
        stepPath,
      );
      if (parallelStep) {
        steps.push(parallelStep);
      }
      return steps;
    }

    if (kind === "pollUntil") {
      const pollStep = parseRunPollUntilStep(
        stepRecord,
        filePath,
        diagnostics,
        stepPath,
      );
      if (pollStep) {
        steps.push(pollStep);
      }
      return steps;
    }

    diagnostics.push({
      level: "error",
      code: "INVALID_STEP_KIND",
      message: `Unsupported run step kind ${kind}.`,
      filePath,
      path: appendDiagnosticPath(stepPath, "kind"),
    });
    return steps;
  }, []);
}

function parseRunRequestStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): RunRequestStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Request steps require a string id.",
    path,
  );
  const uses = readRequiredString(
    record,
    "uses",
    filePath,
    diagnostics,
    "Request steps require a string uses reference.",
    path,
  );
  const withValues = readOptionalFlatVariableMap(
    record.with,
    filePath,
    diagnostics,
    appendDiagnosticPath(path, "with"),
  );

  if (!id || !uses) {
    return undefined;
  }

  const retry = parseOptionalRetryPolicy(
    record.retry,
    filePath,
    diagnostics,
    path,
  );
  const idempotency = parseOptionalIdempotency(
    record.idempotency,
    filePath,
    diagnostics,
    path,
  );

  return {
    kind: "request",
    id,
    uses,
    with: withValues,
    retry,
    idempotency,
  };
}

function parseRunPauseStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): RunPauseStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Pause steps require a string id.",
    path,
  );
  const reason = readRequiredString(
    record,
    "reason",
    filePath,
    diagnostics,
    "Pause steps require a string reason.",
    path,
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
  path: string,
): RunParallelStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Parallel steps require a string id.",
    path,
  );
  const stepsValue = record.steps;
  if (!Array.isArray(stepsValue)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_PARALLEL_STEPS",
      message: "Parallel steps require a steps array.",
      filePath,
      path: appendDiagnosticPath(path, "steps"),
    });
    return undefined;
  }

  const steps = stepsValue.flatMap((entry, index) => {
    const childStepPath = appendDiagnosticPath(
      appendDiagnosticPath(path, "steps"),
      index,
    );
    const childRecord = asRecord(entry);
    if (!childRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Parallel child steps must be objects.",
        filePath,
        path: childStepPath,
      });
      return [];
    }

    const kind = readRequiredString(
      childRecord,
      "kind",
      filePath,
      diagnostics,
      "Parallel child steps require a string kind.",
      childStepPath,
    );
    if (kind !== "request") {
      diagnostics.push({
        level: "error",
        code: "INVALID_PARALLEL_CHILD_KIND",
        message: "Only request steps are allowed inside parallel groups in v0.",
        filePath,
        path: appendDiagnosticPath(childStepPath, "kind"),
      });
      return [];
    }

    const requestStep = parseRunRequestStep(
      childRecord,
      filePath,
      diagnostics,
      childStepPath,
    );
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

function parseRunPollUntilStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): RunPollUntilStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "pollUntil steps require a string id.",
    path,
  );

  const requestRecord = asRecord(record.request);
  if (!requestRecord) {
    diagnostics.push({
      level: "error",
      code: "INVALID_POLL_REQUEST",
      message: "pollUntil steps require a request object.",
      filePath,
      path: appendDiagnosticPath(path, "request"),
    });
    return undefined;
  }

  const uses = readRequiredString(
    requestRecord,
    "uses",
    filePath,
    diagnostics,
    "pollUntil request requires a string uses reference.",
    appendDiagnosticPath(path, "request"),
  );
  const withValues = readOptionalFlatVariableMap(
    requestRecord.with,
    filePath,
    diagnostics,
    appendDiagnosticPath(path, "request.with"),
  );

  const untilRecord = asRecord(record.until);
  if (!untilRecord) {
    diagnostics.push({
      level: "error",
      code: "INVALID_POLL_UNTIL",
      message: "pollUntil steps require an until object.",
      filePath,
      path: appendDiagnosticPath(path, "until"),
    });
    return undefined;
  }

  const jsonPath = readRequiredString(
    untilRecord,
    "jsonPath",
    filePath,
    diagnostics,
    "pollUntil until.jsonPath must be a string.",
    appendDiagnosticPath(path, "until"),
  );

  const intervalMs = readOptionalNumber(
    record,
    "intervalMs",
    filePath,
    diagnostics,
    path,
  );
  const maxAttempts = readOptionalNumber(
    record,
    "maxAttempts",
    filePath,
    diagnostics,
    path,
  );
  const timeoutMs = readOptionalNumber(
    record,
    "timeoutMs",
    filePath,
    diagnostics,
    path,
  );

  if (!id || !uses || !jsonPath || intervalMs === undefined) {
    return undefined;
  }

  if (intervalMs < 100) {
    diagnostics.push({
      level: "error",
      code: "INVALID_POLL_INTERVAL",
      message: "pollUntil.intervalMs must be at least 100ms.",
      filePath,
      path: appendDiagnosticPath(path, "intervalMs"),
    });
    return undefined;
  }

  return {
    kind: "pollUntil",
    id,
    request: {
      uses,
      with: withValues,
    },
    until: {
      jsonPath,
      equals:
        untilRecord.equals !== undefined && isJsonValue(untilRecord.equals)
          ? untilRecord.equals
          : undefined,
      gte: typeof untilRecord.gte === "number" ? untilRecord.gte : undefined,
      lte: typeof untilRecord.lte === "number" ? untilRecord.lte : undefined,
      gt: typeof untilRecord.gt === "number" ? untilRecord.gt : undefined,
      lt: typeof untilRecord.lt === "number" ? untilRecord.lt : undefined,
      exists:
        typeof untilRecord.exists === "boolean"
          ? untilRecord.exists
          : undefined,
    },
    intervalMs,
    maxAttempts,
    timeoutMs,
  };
}

function parseOptionalRetryPolicy(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): RetryPolicy | undefined {
  if (value === undefined) return undefined;

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_RETRY",
      message: "retry must be an object when present.",
      filePath,
      path: appendDiagnosticPath(path, "retry"),
    });
    return undefined;
  }

  const maxAttempts =
    typeof record.maxAttempts === "number" ? record.maxAttempts : undefined;
  if (!maxAttempts || maxAttempts < 1) {
    diagnostics.push({
      level: "error",
      code: "INVALID_RETRY_MAX_ATTEMPTS",
      message: "retry.maxAttempts must be a positive number.",
      filePath,
      path: appendDiagnosticPath(path, "retry.maxAttempts"),
    });
    return undefined;
  }

  const validBackoffs = ["exponential", "linear", "constant"];
  const backoff =
    typeof record.backoff === "string" && validBackoffs.includes(record.backoff)
      ? (record.backoff as RetryPolicy["backoff"])
      : undefined;

  const validJitters = ["full", "equal", "none"];
  const jitter =
    typeof record.jitter === "string" && validJitters.includes(record.jitter)
      ? (record.jitter as RetryPolicy["jitter"])
      : undefined;

  let retryOn: RetryPolicy["retryOn"];
  const retryOnRecord = asRecord(record.retryOn);
  if (retryOnRecord) {
    retryOn = {
      status:
        Array.isArray(retryOnRecord.status) &&
        retryOnRecord.status.every((s: unknown) => typeof s === "number")
          ? retryOnRecord.status
          : undefined,
      errorClass:
        Array.isArray(retryOnRecord.errorClass) &&
        retryOnRecord.errorClass.every((s: unknown) => typeof s === "string")
          ? retryOnRecord.errorClass
          : undefined,
    };
  }

  return {
    maxAttempts,
    initialDelayMs:
      typeof record.initialDelayMs === "number"
        ? record.initialDelayMs
        : undefined,
    maxDelayMs:
      typeof record.maxDelayMs === "number" ? record.maxDelayMs : undefined,
    backoff,
    jitter,
    retryOn,
  };
}

function parseOptionalIdempotency(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): IdempotencyConfig | undefined {
  if (value === undefined) return undefined;

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_IDEMPOTENCY",
      message: "idempotency must be an object when present.",
      filePath,
      path: appendDiagnosticPath(path, "idempotency"),
    });
    return undefined;
  }

  const header = readRequiredString(
    record,
    "header",
    filePath,
    diagnostics,
    "idempotency.header must be a string.",
    appendDiagnosticPath(path, "idempotency"),
  );
  const idempValue = readRequiredString(
    record,
    "value",
    filePath,
    diagnostics,
    "idempotency.value must be a string.",
    appendDiagnosticPath(path, "idempotency"),
  );

  if (!header || !idempValue) return undefined;

  return { header, value: idempValue };
}

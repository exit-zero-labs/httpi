import type {
  CompiledParallelStep,
  CompiledRequestStep,
  CompiledRunSnapshot,
  DescribeRunStep,
} from "@exit-zero-labs/httpi-contracts";
import { exitCodes, HttpiError } from "@exit-zero-labs/httpi-shared";

export function describeCompiledStep(
  step: CompiledRunSnapshot["steps"][number],
): DescribeRunStep {
  if (step.kind === "parallel") {
    return {
      id: step.id,
      kind: step.kind,
      children: step.steps.map((childStep) => describeCompiledStep(childStep)),
    };
  }

  if (step.kind === "pause") {
    return {
      id: step.id,
      kind: step.kind,
      reason: step.reason,
    };
  }

  return {
    id: step.id,
    kind: step.kind,
    requestId: step.requestId,
  };
}

export function selectExplainStep(
  compiled: CompiledRunSnapshot,
  stepId?: string,
): CompiledRequestStep {
  if (stepId) {
    const matchingRequestStep = findRequestStep(compiled, stepId);
    if (!matchingRequestStep) {
      throw new HttpiError(
        "STEP_NOT_FOUND",
        `Step ${stepId} was not found in run ${compiled.runId}.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    return matchingRequestStep;
  }

  const firstRequestStep = compiled.steps.find(
    (step): step is CompiledRequestStep => step.kind === "request",
  );
  if (firstRequestStep) {
    return firstRequestStep;
  }

  const parallelRequestStep = compiled.steps.find(
    (step): step is CompiledParallelStep => step.kind === "parallel",
  );
  if (parallelRequestStep?.steps[0]) {
    return parallelRequestStep.steps[0];
  }

  throw new HttpiError(
    "RUN_HAS_NO_REQUESTS",
    `Run ${compiled.runId} has no request steps to explain.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function findRequestStep(
  compiled: CompiledRunSnapshot,
  stepId: string,
): CompiledRequestStep | undefined {
  for (const step of compiled.steps) {
    if (step.kind === "request" && step.id === stepId) {
      return step;
    }

    if (step.kind === "parallel") {
      const childStep = step.steps.find((entry) => entry.id === stepId);
      if (childStep) {
        return childStep;
      }
    }
  }

  return undefined;
}

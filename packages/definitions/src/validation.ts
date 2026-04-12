import type {
  Diagnostic,
  ProjectFiles,
  RunFile,
  RunStepDefinition,
} from "@exit-zero-labs/httpi-contracts";
import { appendDiagnosticPath } from "@exit-zero-labs/httpi-contracts";
import { sanitizeFileSegment } from "@exit-zero-labs/httpi-shared";

export function validateProjectReferences(project: ProjectFiles): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (
    project.config.defaultEnv &&
    !project.environments[project.config.defaultEnv]
  ) {
    diagnostics.push({
      level: "error",
      code: "DEFAULT_ENV_NOT_FOUND",
      message: `defaultEnv ${project.config.defaultEnv} does not exist.`,
      filePath: project.configPath,
      path: "defaultEnv",
    });
  }

  for (const requestFile of Object.values(project.requests)) {
    for (const headerBlockId of requestFile.definition.uses?.headers ?? []) {
      if (!project.headerBlocks[headerBlockId]) {
        diagnostics.push({
          level: "error",
          code: "HEADER_BLOCK_NOT_FOUND",
          message: `Header block ${headerBlockId} referenced by request ${requestFile.id} does not exist.`,
          filePath: requestFile.filePath,
          path: "uses.headers",
        });
      }
    }

    if (
      requestFile.definition.uses?.auth &&
      !project.authBlocks[requestFile.definition.uses.auth]
    ) {
      diagnostics.push({
        level: "error",
        code: "AUTH_BLOCK_NOT_FOUND",
        message: `Auth block ${requestFile.definition.uses.auth} referenced by request ${requestFile.id} does not exist.`,
        filePath: requestFile.filePath,
        path: "uses.auth",
      });
    }
  }

  for (const runFile of Object.values(project.runs)) {
    if (
      runFile.definition.env &&
      !project.environments[runFile.definition.env]
    ) {
      diagnostics.push({
        level: "error",
        code: "RUN_ENV_NOT_FOUND",
        message: `Run ${runFile.id} references environment ${runFile.definition.env}, which does not exist.`,
        filePath: runFile.filePath,
        path: "env",
      });
    }

    const stepIds = new Set<string>();
    const sanitizedStepIds = new Map<string, string>();
    validateRunSteps(
      project,
      runFile,
      runFile.definition.steps,
      diagnostics,
      stepIds,
      sanitizedStepIds,
    );
  }

  return diagnostics;
}

function validateRunSteps(
  project: ProjectFiles,
  runFile: RunFile,
  steps: RunStepDefinition[],
  diagnostics: Diagnostic[],
  stepIds: Set<string>,
  sanitizedStepIds: Map<string, string>,
): void {
  for (const [index, step] of steps.entries()) {
    const stepPath = appendDiagnosticPath("steps", index);
    const stepIdPath = appendDiagnosticPath(stepPath, "id");
    if (stepIds.has(step.id)) {
      diagnostics.push({
        level: "error",
        code: "DUPLICATE_STEP_ID",
        message: `Run ${runFile.id} contains duplicate step id ${step.id}.`,
        filePath: runFile.filePath,
        path: stepIdPath,
      });
      continue;
    }

    stepIds.add(step.id);
    validateArtifactSafeStepId(
      runFile,
      step.id,
      diagnostics,
      sanitizedStepIds,
      stepIdPath,
    );

    if (step.kind === "request") {
      if (!project.requests[step.uses]) {
        diagnostics.push({
          level: "error",
          code: "REQUEST_NOT_FOUND",
          message: `Step ${step.id} references request ${step.uses}, which does not exist.`,
          filePath: runFile.filePath,
          path: appendDiagnosticPath(stepPath, "uses"),
        });
      }
      continue;
    }

    if (step.kind === "pollUntil") {
      if (!project.requests[step.request.uses]) {
        diagnostics.push({
          level: "error",
          code: "REQUEST_NOT_FOUND",
          message: `pollUntil step ${step.id} references request ${step.request.uses}, which does not exist.`,
          filePath: runFile.filePath,
          path: appendDiagnosticPath(stepPath, "request.uses"),
        });
      }
      continue;
    }

    if (step.kind === "parallel") {
      const childStepsPath = appendDiagnosticPath(stepPath, "steps");
      for (const [childIndex, childStep] of step.steps.entries()) {
        const childStepPath = appendDiagnosticPath(childStepsPath, childIndex);
        const childStepIdPath = appendDiagnosticPath(childStepPath, "id");
        if (stepIds.has(childStep.id)) {
          diagnostics.push({
            level: "error",
            code: "DUPLICATE_STEP_ID",
            message: `Run ${runFile.id} contains duplicate step id ${childStep.id}.`,
            filePath: runFile.filePath,
            path: childStepIdPath,
          });
          continue;
        }

        stepIds.add(childStep.id);
        validateArtifactSafeStepId(
          runFile,
          childStep.id,
          diagnostics,
          sanitizedStepIds,
          childStepIdPath,
        );
        if (!project.requests[childStep.uses]) {
          diagnostics.push({
            level: "error",
            code: "REQUEST_NOT_FOUND",
            message: `Parallel child step ${childStep.id} references request ${childStep.uses}, which does not exist.`,
            filePath: runFile.filePath,
            path: appendDiagnosticPath(childStepPath, "uses"),
          });
        }
      }
    }
  }
}

function validateArtifactSafeStepId(
  runFile: RunFile,
  stepId: string,
  diagnostics: Diagnostic[],
  sanitizedStepIds: Map<string, string>,
  path: string,
): void {
  const sanitizedStepId = sanitizeFileSegment(stepId);
  const existingStepId = sanitizedStepIds.get(sanitizedStepId);
  if (existingStepId && existingStepId !== stepId) {
    diagnostics.push({
      level: "error",
      code: "STEP_ID_PATH_COLLISION",
      message: `Run ${runFile.id} contains step ids ${existingStepId} and ${stepId}, which both sanitize to ${sanitizedStepId} for artifact paths.`,
      filePath: runFile.filePath,
      path,
    });
    return;
  }

  sanitizedStepIds.set(sanitizedStepId, stepId);
}

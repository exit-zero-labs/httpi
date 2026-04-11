import type {
  CompiledRequestStep,
  CompiledRunSnapshot,
  FlatVariableMap,
  SessionRecord,
  SessionStepRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  findProjectRoot,
  loadProjectFiles,
} from "@exit-zero-labs/httpi-definitions";
import { exitCodes, HttpiError } from "@exit-zero-labs/httpi-shared";
import type { EngineOptions, LoadedProjectContext } from "./types.js";

export function buildCompileOptions(
  envId?: string,
  overrides?: FlatVariableMap,
): {
  envId?: string | undefined;
  overrides?: FlatVariableMap | undefined;
  processEnv: Record<string, string | undefined>;
} {
  return {
    envId,
    overrides,
    processEnv: process.env,
  };
}

export function getSingleRequestStep(
  compiled: CompiledRunSnapshot,
  targetId: string,
): CompiledRequestStep {
  const step = compiled.steps[0];
  if (!step || step.kind !== "request") {
    throw new HttpiError(
      "INVALID_COMPILED_REQUEST",
      `Compiled request ${targetId} did not produce a request step.`,
    );
  }

  return step;
}

export function getSessionStepRecord(
  session: SessionRecord,
  stepId: string,
): SessionStepRecord {
  const stepRecord = session.stepRecords[stepId];
  if (!stepRecord) {
    throw new HttpiError(
      "STEP_NOT_FOUND",
      `Step ${stepId} was not found in session ${session.sessionId}.`,
      { exitCode: exitCodes.internalError },
    );
  }

  return stepRecord;
}

export async function loadProjectContext(
  options: EngineOptions,
): Promise<LoadedProjectContext> {
  const rootDir = await findProjectRoot(options);
  const project = await loadProjectFiles(rootDir);
  return {
    rootDir,
    project,
  };
}

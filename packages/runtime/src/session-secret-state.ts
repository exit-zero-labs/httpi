import type {
  FlatVariableMap,
  FlatVariableValue,
  SessionRecord,
} from "@exit-zero-labs/runmark-contracts";
import { schemaVersion } from "@exit-zero-labs/runmark-contracts";
import {
  exitCodes,
  fileExists,
  readJsonFile,
  redactedValue,
  removeFileIfExists,
  RunmarkError,
  writeJsonFileAtomic,
} from "@exit-zero-labs/runmark-shared";
import {
  assertProjectOwnedFileIfExists,
  ensureRuntimePaths,
  getSessionRuntimePaths,
  runtimeFileMode,
} from "./runtime-paths.js";

interface SessionSecretState {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  runInputs?: FlatVariableMap | undefined;
  stepOutputs?: Record<string, Record<string, FlatVariableValue>> | undefined;
}

export function splitSessionForStorage(session: SessionRecord): {
  storedSession: SessionRecord;
  secretState?: SessionSecretState;
} {
  const [storedRunInputs, secretRunInputs] = splitFlatVariableMap(
    session.compiled.runInputs,
    new Set(session.compiled.overrideKeys ?? []),
  );
  const storedStepOutputs: Record<string, Record<string, FlatVariableValue>> = {};
  const storedStepRecords = Object.fromEntries(
    Object.entries(session.stepRecords).map(([stepId, stepRecord]) => {
      const [storedOutput] = splitFlatVariableMap(
        stepRecord.output,
        new Set(stepRecord.secretOutputKeys ?? []),
      );
      const sourceOutput = session.stepOutputs[stepId];
      if (sourceOutput) {
        const [storedSessionOutput] = splitFlatVariableMap(
          sourceOutput,
          new Set(stepRecord.secretOutputKeys ?? []),
        );
        storedStepOutputs[stepId] = storedSessionOutput;
      }
      return [
        stepId,
        {
          ...stepRecord,
          output: storedOutput,
        },
      ];
    }),
  );

  const secretStepOutputs = Object.fromEntries(
    Object.entries(session.stepOutputs).flatMap(([stepId, values]) => {
      const [_, secretValues] = splitFlatVariableMap(
        values,
        new Set(session.stepRecords[stepId]?.secretOutputKeys ?? []),
      );
      return Object.keys(secretValues).length === 0
        ? []
        : [[stepId, secretValues]];
    }),
  );

  const secretState =
    Object.keys(secretRunInputs).length > 0 ||
    Object.keys(secretStepOutputs).length > 0
      ? {
          schemaVersion,
          sessionId: session.sessionId,
          ...(Object.keys(secretRunInputs).length > 0
            ? { runInputs: secretRunInputs }
            : {}),
          ...(Object.keys(secretStepOutputs).length > 0
            ? { stepOutputs: secretStepOutputs }
            : {}),
        }
      : undefined;

  return {
    storedSession: {
      ...session,
      compiled: {
        ...session.compiled,
        runInputs: storedRunInputs,
      },
      stepOutputs: storedStepOutputs,
      stepRecords: storedStepRecords,
    },
    ...(secretState ? { secretState } : {}),
  };
}

export async function readSessionSecretState(
  projectRoot: string,
  sessionId: string,
): Promise<SessionSecretState | undefined> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  if (!(await fileExists(sessionPaths.secretStatePath))) {
    return undefined;
  }

  await assertProjectOwnedFileIfExists(
    projectRoot,
    sessionPaths.secretStatePath,
    `The secret session state for ${sessionId}`,
  );
  const secretState = await readJsonFile<SessionSecretState>(
    sessionPaths.secretStatePath,
  );
  if (secretState.schemaVersion !== schemaVersion) {
    throw new RunmarkError(
      "SESSION_SECRET_STATE_INVALID",
      `Secret session state for ${sessionId} has schema version ${secretState.schemaVersion}; expected ${schemaVersion}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (secretState.sessionId !== sessionId) {
    throw new RunmarkError(
      "SESSION_SECRET_STATE_INVALID",
      `Secret session state for ${sessionId} is mismatched: found sessionId ${secretState.sessionId}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return secretState;
}

export async function writeSessionSecretState(
  projectRoot: string,
  sessionId: string,
  secretState?: SessionSecretState,
): Promise<void> {
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const sessionPaths = getSessionRuntimePaths(runtimePaths, sessionId);
  if (!secretState) {
    await removeFileIfExists(sessionPaths.secretStatePath);
    return;
  }

  await writeJsonFileAtomic(
    sessionPaths.secretStatePath,
    secretState,
    runtimeFileMode,
  );
}

export function mergeSessionSecretState(
  session: SessionRecord,
  secretState?: SessionSecretState,
): SessionRecord {
  if (!secretState) {
    return session;
  }

  const orphanStepIds = Object.keys(secretState.stepOutputs ?? {}).filter(
    (stepId) => !(stepId in session.stepOutputs) || !(stepId in session.stepRecords),
  );
  if (orphanStepIds.length > 0) {
    throw new RunmarkError(
      "SESSION_SECRET_STATE_INVALID",
      `Secret session state for ${session.sessionId} is out of sync for steps: ${orphanStepIds.join(", ")}.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return {
    ...session,
    compiled: {
      ...session.compiled,
      runInputs: {
        ...session.compiled.runInputs,
        ...(secretState.runInputs ?? {}),
      },
    },
    stepRecords: Object.fromEntries(
      Object.entries(session.stepRecords).map(([stepId, stepRecord]) => [
        stepId,
        {
          ...stepRecord,
          output: {
            ...stepRecord.output,
            ...(secretState.stepOutputs?.[stepId] ?? {}),
          },
        },
      ]),
    ),
    stepOutputs: Object.fromEntries(
      Object.entries(session.stepOutputs).map(([stepId, values]) => [
        stepId,
        {
          ...values,
          ...(secretState.stepOutputs?.[stepId] ?? {}),
        },
      ]),
    ),
  };
}

function splitFlatVariableMap(
  values: Record<string, FlatVariableValue>,
  secretKeys: Set<string>,
): [Record<string, FlatVariableValue>, Record<string, FlatVariableValue>] {
  const storedValues: Record<string, FlatVariableValue> = {};
  const extractedSecretValues: Record<string, FlatVariableValue> = {};

  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) {
      storedValues[key] = redactedValue;
      extractedSecretValues[key] = value;
      continue;
    }

    storedValues[key] = value;
  }

  return [storedValues, extractedSecretValues];
}

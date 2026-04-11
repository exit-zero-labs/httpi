import type {
  CompiledParallelStep,
  ExecutionResult,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  acquireSessionLock,
  appendSessionEvent,
  ensureRuntimePaths,
  releaseSessionLock,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";
import { toIsoTimestamp } from "@exit-zero-labs/httpi-shared";
import { getSessionStepRecord } from "./project-context.js";
import { executeRequestStep } from "./request-step-execution.js";
import {
  applyPause,
  findStepStartIndex,
  finishAttempt,
  nextAttemptNumber,
  startAttempt,
} from "./session-attempts.js";
import type { RequestExecutionOutcome } from "./types.js";

export async function executeSession(
  projectRoot: string,
  initialSession: SessionRecord,
): Promise<ExecutionResult> {
  await ensureRuntimePaths(projectRoot);
  const lock = await acquireSessionLock(projectRoot, initialSession.sessionId);

  try {
    let session = initialSession;
    session = {
      ...session,
      state: "running",
      pausedReason: undefined,
      failureReason: undefined,
      updatedAt: toIsoTimestamp(),
    };

    await writeSession(projectRoot, session);
    await appendSessionEvent(projectRoot, session, {
      schemaVersion: session.schemaVersion,
      eventType: "session.running",
      timestamp: toIsoTimestamp(),
      sessionId: session.sessionId,
      runId: session.runId,
      outcome: "running",
    });

    const startIndex = findStepStartIndex(session);
    for (
      let index = startIndex;
      index < session.compiled.steps.length;
      index += 1
    ) {
      const topLevelStep = session.compiled.steps[index];
      if (!topLevelStep) {
        continue;
      }
      const nextTopLevelStep = session.compiled.steps[index + 1];

      if (topLevelStep.kind === "pause") {
        session = applyPause(
          session,
          topLevelStep.id,
          topLevelStep.reason,
          nextTopLevelStep?.id,
        );
        await writeSession(projectRoot, session);
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: session.schemaVersion,
          eventType: "session.paused",
          timestamp: toIsoTimestamp(),
          sessionId: session.sessionId,
          runId: session.runId,
          stepId: topLevelStep.id,
          outcome: "paused",
          message: topLevelStep.reason,
        });
        return {
          session,
          diagnostics: [],
        };
      }

      if (topLevelStep.kind === "parallel") {
        const parallelOutcome = await executeParallelStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...parallelOutcome.session,
          nextStepId: parallelOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
      } else {
        const requestOutcome = await executeRequestStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...requestOutcome.session,
          nextStepId: requestOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
      }

      await writeSession(projectRoot, session);
      if (session.state === "failed") {
        return {
          session,
          diagnostics: [],
        };
      }
    }

    session = {
      ...session,
      state: "completed",
      nextStepId: undefined,
      updatedAt: toIsoTimestamp(),
      pausedReason: undefined,
      failureReason: undefined,
    };
    await writeSession(projectRoot, session);
    await appendSessionEvent(projectRoot, session, {
      schemaVersion: session.schemaVersion,
      eventType: "session.completed",
      timestamp: toIsoTimestamp(),
      sessionId: session.sessionId,
      runId: session.runId,
      outcome: "success",
    });

    return {
      session,
      diagnostics: [],
    };
  } finally {
    await releaseSessionLock(lock);
  }
}

async function executeParallelStep(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledParallelStep,
): Promise<RequestExecutionOutcome> {
  const parallelAttempt = nextAttemptNumber(session, step.id);
  const runningSession = startAttempt(
    session,
    step.id,
    "parallel",
    parallelAttempt,
  );
  await writeSession(projectRoot, runningSession);
  await appendSessionEvent(projectRoot, runningSession, {
    schemaVersion: runningSession.schemaVersion,
    eventType: "step.started",
    timestamp: toIsoTimestamp(),
    sessionId: runningSession.sessionId,
    runId: runningSession.runId,
    stepId: step.id,
    attempt: parallelAttempt,
    outcome: "running",
  });

  // Child results stay in memory here and are merged back into one persisted
  // parent session after the parallel block settles.
  const childResults = await Promise.all(
    step.steps.map(async (childStep) =>
      executeRequestStep(projectRoot, runningSession, childStep, false),
    ),
  );

  let nextSession = runningSession;
  let success = true;
  for (const [index, childResult] of childResults.entries()) {
    const childStep = step.steps[index];
    if (!childStep) {
      continue;
    }

    const childStepRecord = getSessionStepRecord(
      childResult.session,
      childStep.id,
    );
    const childStepOutput = childResult.session.stepOutputs[childStep.id];
    nextSession = {
      ...nextSession,
      stepRecords: {
        ...nextSession.stepRecords,
        [childStep.id]: childStepRecord,
      },
      stepOutputs: {
        ...nextSession.stepOutputs,
        ...(childStepOutput ? { [childStep.id]: childStepOutput } : {}),
      },
      updatedAt: childResult.session.updatedAt,
      ...(childResult.success
        ? {}
        : {
            failureReason: childResult.session.failureReason,
          }),
    };
    success &&= childResult.success;
  }

  const finalizedParentAttempt = finishAttempt(
    nextSession,
    step.id,
    success ? "completed" : "failed",
    parallelAttempt,
    success
      ? {
          outcome: "success",
        }
      : {
          outcome: "failed",
          errorMessage: "One or more child steps failed.",
        },
  );

  const finalSession: SessionRecord = {
    ...finalizedParentAttempt,
    state: success ? "running" : "failed",
    pausedReason: undefined,
    ...(success ? {} : { failureReason: "One or more child steps failed." }),
  };

  await appendSessionEvent(projectRoot, finalSession, {
    schemaVersion: finalSession.schemaVersion,
    eventType: success ? "step.completed" : "step.failed",
    timestamp: toIsoTimestamp(),
    sessionId: finalSession.sessionId,
    runId: finalSession.runId,
    stepId: step.id,
    attempt: parallelAttempt,
    outcome: success ? "success" : "failed",
  });

  return {
    session: finalSession,
    success,
  };
}

/**
 * Top-level session orchestration.
 *
 * This module is responsible for the run loop that advances a compiled session
 * through pause, retry, parallel, polling, and completion semantics while
 * keeping on-disk state and emitted events in sync.
 */
import type {
  CompiledParallelStep,
  CompiledPollUntilStep,
  EnrichedDiagnostic,
  ExecutionResult,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import {
  acquireSessionLock,
  appendSessionEvent,
  clearSessionCancel,
  ensureRuntimePaths,
  isSessionCancelled,
  readSessionCancel,
  registerActiveSession,
  releaseSessionLock,
  unregisterActiveSession,
  writeSession,
} from "@exit-zero-labs/httpi-runtime";
import { toIsoTimestamp } from "@exit-zero-labs/httpi-shared";
import { executeRequestStepIterate } from "./iterate-execution.js";
import { getSessionStepRecord } from "./project-context.js";
import { extractJsonPath } from "./request-outputs.js";
import { executeRequestStep } from "./request-step-execution.js";
import { executeRequestStepWithRetry } from "./retry-execution.js";
import {
  applyPause,
  findStepStartIndex,
  finishAttempt,
  nextAttemptNumber,
  startAttempt,
} from "./session-attempts.js";
import type { RequestExecutionOutcome } from "./types.js";

/**
 * Execute or resume a compiled session until it completes, pauses, fails, or
 * is interrupted. The caller supplies the already-created session snapshot.
 */
export async function executeSession(
  projectRoot: string,
  initialSession: SessionRecord,
): Promise<ExecutionResult> {
  await ensureRuntimePaths(projectRoot);
  await clearSessionCancel(projectRoot, initialSession.sessionId);
  const lock = await acquireSessionLock(projectRoot, initialSession.sessionId);
  registerActiveSession(projectRoot, initialSession.sessionId);

  try {
    let session = initialSession;
    const diagnostics: EnrichedDiagnostic[] = [];
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
    const runStartedAt = performance.now();
    const runTimeoutMs = session.compiled.runTimeoutMs;
    for (
      let index = startIndex;
      index < session.compiled.steps.length;
      index += 1
    ) {
      // Per-step cancel check (A2): poll the cancel marker written by the CLI
      // `httpi cancel` subcommand or MCP `cancel_session` tool.
      if (await isSessionCancelled(projectRoot, session.sessionId)) {
        const cancel = await readSessionCancel(projectRoot, session.sessionId);
        session = {
          ...session,
          state: "interrupted",
          failureReason:
            cancel?.reason ?? `Cancelled via ${cancel?.source ?? "external"}.`,
          updatedAt: toIsoTimestamp(),
        };
        await writeSession(projectRoot, session);
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: session.schemaVersion,
          eventType: "session.interrupted",
          timestamp: toIsoTimestamp(),
          sessionId: session.sessionId,
          runId: session.runId,
          outcome: "interrupted",
          ...(cancel?.reason ? { message: cancel.reason } : {}),
        });
        return { session, diagnostics };
      }

      // Run-level timeout (A2): when the wall clock exceeds the compiled
      // runTimeoutMs, abort the remaining steps and surface `interrupted`.
      if (
        typeof runTimeoutMs === "number" &&
        runTimeoutMs > 0 &&
        performance.now() - runStartedAt >= runTimeoutMs
      ) {
        session = {
          ...session,
          state: "interrupted",
          failureReason: `Run exceeded timeoutMs=${runTimeoutMs}.`,
          updatedAt: toIsoTimestamp(),
        };
        await writeSession(projectRoot, session);
        await appendSessionEvent(projectRoot, session, {
          schemaVersion: session.schemaVersion,
          eventType: "session.interrupted",
          timestamp: toIsoTimestamp(),
          sessionId: session.sessionId,
          runId: session.runId,
          outcome: "interrupted",
          message: `run timeout ${runTimeoutMs}ms`,
        });
        return { session, diagnostics };
      }

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
          diagnostics,
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
        diagnostics.push(...parallelOutcome.diagnostics);
      } else if (topLevelStep.kind === "switch") {
        const switchOutcome = await executeSwitchStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...switchOutcome.session,
          nextStepId: switchOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
        diagnostics.push(...switchOutcome.diagnostics);
      } else if (topLevelStep.kind === "pollUntil") {
        const pollOutcome = await executePollUntilStep(
          projectRoot,
          session,
          topLevelStep,
        );
        session = {
          ...pollOutcome.session,
          nextStepId: pollOutcome.success
            ? nextTopLevelStep?.id
            : topLevelStep.id,
        };
        diagnostics.push(...pollOutcome.diagnostics);
      } else {
        const requestOutcome = topLevelStep.iterate
          ? await executeRequestStepIterate(projectRoot, session, topLevelStep)
          : await executeRequestStepWithRetry(
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
        diagnostics.push(...requestOutcome.diagnostics);
      }

      await writeSession(projectRoot, session);
      if (session.state === "failed") {
        return {
          session,
          diagnostics,
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
      diagnostics,
    };
  } finally {
    unregisterActiveSession(projectRoot, initialSession.sessionId);
    await releaseSessionLock(lock);
  }
}

async function executeParallelStep(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledParallelStep,
): Promise<RequestExecutionOutcome> {
  // Enforce blockParallelAbove guard from environment (D4)
  const guards = session.compiled.envGuards;
  if (
    guards?.blockParallelAbove !== undefined &&
    step.steps.length > guards.blockParallelAbove
  ) {
    const message = `Environment ${session.compiled.envId} blocks parallel execution above ${guards.blockParallelAbove} children. This step has ${step.steps.length}.`;
    return {
      session: {
        ...session,
        state: "failed",
        failureReason: message,
        updatedAt: toIsoTimestamp(),
      },
      success: false,
      diagnostics: [],
    };
  }

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
  // C7: honor declared concurrency cap; `undefined` = unbounded (original
  // fan-out behavior via Promise.all).
  const cap = step.concurrency;
  const childResults: Array<Awaited<ReturnType<typeof executeRequestStep>>> =
    new Array(step.steps.length);
  if (!cap || cap <= 0 || cap >= step.steps.length) {
    const settled = await Promise.all(
      step.steps.map(async (childStep) =>
        executeRequestStep(projectRoot, runningSession, childStep, false),
      ),
    );
    for (let i = 0; i < settled.length; i++) childResults[i] = settled[i]!;
  } else {
    let cursor = 0;
    await Promise.all(
      Array.from({ length: cap }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= step.steps.length) return;
          const childStep = step.steps[index]!;
          childResults[index] = await executeRequestStep(
            projectRoot,
            runningSession,
            childStep,
            false,
          );
        }
      }),
    );
  }

  let nextSession = runningSession;
  let success = true;
  const diagnostics: EnrichedDiagnostic[] = [];
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
    diagnostics.push(...childResult.diagnostics);
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
    diagnostics,
  };
}

async function executePollUntilStep(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledPollUntilStep,
): Promise<RequestExecutionOutcome> {
  const startTime = performance.now();
  const maxAttempts = step.maxAttempts;
  const timeoutMs = step.timeoutMs;
  let currentSession = session;
  const diagnostics: EnrichedDiagnostic[] = [];

  // Create outer step record for the pollUntil container
  const pollAttempt = nextAttemptNumber(currentSession, step.id);
  currentSession = startAttempt(
    currentSession,
    step.id,
    "pollUntil",
    pollAttempt,
  );
  await writeSession(projectRoot, currentSession);
  await appendSessionEvent(projectRoot, currentSession, {
    schemaVersion: currentSession.schemaVersion,
    eventType: "step.started",
    timestamp: toIsoTimestamp(),
    sessionId: currentSession.sessionId,
    runId: currentSession.runId,
    stepId: step.id,
    attempt: pollAttempt,
    outcome: "running",
  });

  for (let poll = 1; poll <= maxAttempts; poll++) {
    // Check timeout
    if (timeoutMs !== undefined) {
      const elapsed = performance.now() - startTime;
      if (elapsed >= timeoutMs) {
        currentSession = finishAttempt(
          currentSession,
          step.id,
          "failed",
          pollAttempt,
          {
            outcome: "failed",
            errorMessage: `pollUntil timed out after ${Math.round(elapsed)}ms.`,
          },
        );
        currentSession = {
          ...currentSession,
          state: "failed",
          failureReason: `pollUntil ${step.id} timed out after ${Math.round(elapsed)}ms.`,
          updatedAt: toIsoTimestamp(),
        };
        await appendSessionEvent(projectRoot, currentSession, {
          schemaVersion: currentSession.schemaVersion,
          eventType: "step.failed",
          timestamp: toIsoTimestamp(),
          sessionId: currentSession.sessionId,
          runId: currentSession.runId,
          stepId: step.id,
          outcome: "failed",
          message: "timeout",
        });
        return { session: currentSession, success: false, diagnostics };
      }
    }

    // Execute the poll request — persist: false to keep state in memory
    const outcome = await executeRequestStep(
      projectRoot,
      currentSession,
      step.requestStep,
    );
    currentSession = outcome.session;
    diagnostics.push(...outcome.diagnostics);

    if (!outcome.success) {
      if (poll >= maxAttempts) {
        currentSession = finishAttempt(
          currentSession,
          step.id,
          "failed",
          pollAttempt,
          {
            outcome: "failed",
            errorMessage: "Poll request failed on final attempt.",
          },
        );
        await appendSessionEvent(projectRoot, currentSession, {
          schemaVersion: currentSession.schemaVersion,
          eventType: "step.failed",
          timestamp: toIsoTimestamp(),
          sessionId: currentSession.sessionId,
          runId: currentSession.runId,
          stepId: step.id,
          outcome: "failed",
          message: "Poll request failed on final attempt.",
        });
        return { session: currentSession, success: false, diagnostics };
      }
      currentSession = {
        ...currentSession,
        state: "running",
        failureReason: undefined,
        updatedAt: toIsoTimestamp(),
      };
      await writeSession(projectRoot, currentSession);
      await sleep(step.intervalMs);
      continue;
    }

    // Evaluate condition using extracted step outputs (does not depend on capture policy)
    const stepOutput = currentSession.stepOutputs[step.requestStep.id] ?? {};
    const conditionMet = evaluatePollCondition(step.until, stepOutput);

    if (conditionMet) {
      currentSession = finishAttempt(
        currentSession,
        step.id,
        "completed",
        pollAttempt,
        { outcome: "success" },
      );
      currentSession = {
        ...currentSession,
        state: "running",
        updatedAt: toIsoTimestamp(),
      };
      await appendSessionEvent(projectRoot, currentSession, {
        schemaVersion: currentSession.schemaVersion,
        eventType: "step.completed",
        timestamp: toIsoTimestamp(),
        sessionId: currentSession.sessionId,
        runId: currentSession.runId,
        stepId: step.id,
        outcome: "success",
        message: `Condition met after ${poll} poll(s).`,
      });
      return { session: currentSession, success: true, diagnostics };
    }

    if (poll >= maxAttempts) {
      currentSession = finishAttempt(
        currentSession,
        step.id,
        "failed",
        pollAttempt,
        {
          outcome: "failed",
          errorMessage: `Exhausted ${maxAttempts} attempts.`,
        },
      );
      currentSession = {
        ...currentSession,
        state: "failed",
        failureReason: `pollUntil ${step.id} exhausted ${maxAttempts} attempts.`,
        updatedAt: toIsoTimestamp(),
      };
      await appendSessionEvent(projectRoot, currentSession, {
        schemaVersion: currentSession.schemaVersion,
        eventType: "step.failed",
        timestamp: toIsoTimestamp(),
        sessionId: currentSession.sessionId,
        runId: currentSession.runId,
        stepId: step.id,
        outcome: "failed",
        message: `Exhausted ${maxAttempts} attempts.`,
      });
      return { session: currentSession, success: false, diagnostics };
    }

    await sleep(step.intervalMs);
  }

  return { session: currentSession, success: false, diagnostics };
}

function evaluatePollCondition(
  condition: CompiledPollUntilStep["until"],
  data: unknown,
): boolean {
  const value = extractJsonPath(
    data as import("@exit-zero-labs/httpi-contracts").JsonValue,
    condition.jsonPath,
  );
  if (value === undefined) {
    return condition.exists === false;
  }

  if (condition.exists !== undefined) {
    return condition.exists === true;
  }
  if (condition.equals !== undefined) {
    return JSON.stringify(value) === JSON.stringify(condition.equals);
  }
  if (typeof value === "number") {
    if (condition.gte !== undefined && value < condition.gte) return false;
    if (condition.lte !== undefined && value > condition.lte) return false;
    if (condition.gt !== undefined && value <= condition.gt) return false;
    if (condition.lt !== undefined && value >= condition.lt) return false;
    return true;
  }
  return false;
}

async function executeSwitchStep(
  projectRoot: string,
  session: SessionRecord,
  step: import("@exit-zero-labs/httpi-contracts").CompiledSwitchStep,
): Promise<RequestExecutionOutcome> {
  const diagnostics: import("@exit-zero-labs/httpi-contracts").EnrichedDiagnostic[] =
    [];
  let currentSession = session;
  const value = resolveSwitchRef(step.on, currentSession);
  await appendSessionEvent(projectRoot, currentSession, {
    schemaVersion: currentSession.schemaVersion,
    eventType: "step.switch.evaluated",
    timestamp: toIsoTimestamp(),
    sessionId: currentSession.sessionId,
    runId: currentSession.runId,
    stepId: step.id,
    outcome: "running",
    message: `on=${step.on} value=${JSON.stringify(value)}`,
  });

  const matchedSteps = pickSwitchBranch(step, value);
  if (matchedSteps === undefined) {
    // No case matched and no default — step succeeds with a no-op.
    return { session: currentSession, success: true, diagnostics };
  }

  for (const child of matchedSteps) {
    const outcome = child.iterate
      ? await executeRequestStepIterate(projectRoot, currentSession, child)
      : await executeRequestStepWithRetry(projectRoot, currentSession, child);
    currentSession = outcome.session;
    diagnostics.push(...outcome.diagnostics);
    if (!outcome.success) {
      return { session: currentSession, success: false, diagnostics };
    }
  }
  return { session: currentSession, success: true, diagnostics };
}

function pickSwitchBranch(
  step: import("@exit-zero-labs/httpi-contracts").CompiledSwitchStep,
  value: unknown,
): import("@exit-zero-labs/httpi-contracts").CompiledRequestStep[] | undefined {
  for (const c of step.cases) {
    const expected = c.when;
    const matched = Array.isArray(expected)
      ? expected.some((e) => JSON.stringify(e) === JSON.stringify(value))
      : JSON.stringify(expected) === JSON.stringify(value);
    if (matched) return c.steps;
  }
  return step.defaultSteps;
}

function resolveSwitchRef(ref: string, session: SessionRecord): unknown {
  // Supported:
  //   steps.<id>.response.status
  //   steps.<id>.response.headers["x-foo"]
  //   steps.<id>.extracted.<name>
  const statusMatch = ref.match(/^steps\.([A-Za-z0-9_-]+)\.response\.status$/);
  if (statusMatch) {
    const stepId = statusMatch[1]!;
    const record = session.stepRecords[stepId];
    const lastAttempt = record?.attempts[record.attempts.length - 1];
    return lastAttempt?.statusCode;
  }
  const headerMatch = ref.match(
    /^steps\.([A-Za-z0-9_-]+)\.response\.headers\["(.+?)"\]$/,
  );
  if (headerMatch) {
    // Header values live in captured artifacts, not the session record in v1.
    // Resolve via the step's stepOutputs where response headers are extracted
    // to, if any; otherwise return undefined.
    const stepId = headerMatch[1]!;
    const headerName = headerMatch[2]!.toLowerCase();
    const output = session.stepOutputs[stepId] ?? {};
    return output[`response.headers.${headerName}`];
  }
  const extractedMatch = ref.match(
    /^steps\.([A-Za-z0-9_-]+)\.extracted\.([A-Za-z0-9_-]+)$/,
  );
  if (extractedMatch) {
    const stepId = extractedMatch[1]!;
    const name = extractedMatch[2]!;
    const output = session.stepOutputs[stepId] ?? {};
    return output[name];
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

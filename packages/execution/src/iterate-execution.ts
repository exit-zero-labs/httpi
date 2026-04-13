import type {
  CompiledRequestStep,
  SessionRecord,
} from "@exit-zero-labs/httpi-contracts";
import { appendSessionEvent } from "@exit-zero-labs/httpi-runtime";
import { toIsoTimestamp } from "@exit-zero-labs/httpi-shared";
import { evaluateAggregateAssertions } from "./assertions.js";
import { summarizeIterations } from "./percentiles.js";
import { executeRequestStepWithRetry } from "./retry-execution.js";
import type { RequestExecutionOutcome } from "./types.js";

/**
 * B6 iterate executor. Runs the same request step N times (optionally with
 * bounded concurrency), collects per-iteration latency and success, and
 * evaluates `expect.aggregate` against the computed summary. Emits a
 * `step.iterate.summary` event so artifacts and tooling can surface the
 * percentile table.
 *
 * v1 notes:
 * - Concurrency > 1 is accepted but executed serially for session-safety;
 *   the session file is mutated by each inner attempt and the existing
 *   attempt-tracking machinery is not yet parallel-safe. The contract is
 *   stable; a future turn can add an in-memory fan-out without changing
 *   callers.
 */
export async function executeRequestStepIterate(
  projectRoot: string,
  session: SessionRecord,
  step: CompiledRequestStep,
): Promise<RequestExecutionOutcome> {
  const iterate = step.iterate;
  if (!iterate) {
    return executeRequestStepWithRetry(projectRoot, session, step);
  }

  let currentSession = session;
  const outcomes: Array<{ success: boolean; durationMs: number }> = [];
  for (let i = 0; i < iterate.count; i++) {
    const start = performance.now();
    const outcome = await executeRequestStepWithRetry(
      projectRoot,
      currentSession,
      step,
    );
    const durationMs = Math.round(performance.now() - start);
    outcomes.push({ success: outcome.success, durationMs });
    currentSession = outcome.session;
  }

  const summary = summarizeIterations(outcomes);
  await appendSessionEvent(projectRoot, currentSession, {
    schemaVersion: currentSession.schemaVersion,
    eventType: "step.iterate.summary",
    timestamp: toIsoTimestamp(),
    sessionId: currentSession.sessionId,
    runId: currentSession.runId,
    stepId: step.id,
    outcome: "success",
    message: `iterations=${summary.iterations} p50=${summary.latencyMs.p50.toFixed(1)} p95=${summary.latencyMs.p95.toFixed(1)} p99=${summary.latencyMs.p99.toFixed(1)} errorRate=${summary.errorRate.toFixed(3)}`,
  });

  // Evaluate aggregate matcher if declared.
  const aggExpect = step.request.expect?.aggregate;
  if (aggExpect) {
    const results = evaluateAggregateAssertions(aggExpect, summary);
    const failures = results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const [first] = failures;
      if (!first) {
        throw new Error("Expected at least one aggregate assertion failure.");
      }
      const message = `Aggregate assertion failed: ${first.path} ${first.matcher} expected ${JSON.stringify(first.expected)} got ${JSON.stringify(first.actual)}.`;
      await appendSessionEvent(projectRoot, currentSession, {
        schemaVersion: currentSession.schemaVersion,
        eventType: "step.iterate.aggregate-failed",
        timestamp: toIsoTimestamp(),
        sessionId: currentSession.sessionId,
        runId: currentSession.runId,
        stepId: step.id,
        outcome: "failed",
        message,
      });
      return {
        session: {
          ...currentSession,
          state: "failed",
          failureReason: message,
          updatedAt: toIsoTimestamp(),
        },
        success: false,
        diagnostics: [],
      };
    }
  }

  return { session: currentSession, success: true, diagnostics: [] };
}

import { readFile, writeFile } from "node:fs/promises";
import {
  exitCodes,
  fileExists,
  RunmarkError,
  removeFileIfExists,
  toIsoTimestamp,
} from "@exit-zero-labs/runmark-shared";
import {
  assertValidSessionId,
  ensureRuntimePaths,
  getSessionRuntimePaths,
  runtimeFileMode,
} from "./runtime-paths.js";

/**
 * Cross-process cancellation signal for a session. The CLI `runmark cancel` and
 * MCP `cancel_session` write a marker file that the executing run polls at
 * step boundaries and stream read-loop iterations.
 *
 * Layout: `runmark/artifacts/sessions/<sessionId>.cancel`
 */

export interface SessionCancelRecord {
  sessionId: string;
  requestedAt: string;
  reason?: string;
  source?: string;
}

/** Write the cross-process cancel marker that executors poll while running. */
export async function requestSessionCancel(
  projectRoot: string,
  sessionId: string,
  options: { reason?: string; source?: string } = {},
): Promise<SessionCancelRecord> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const markerPath = getSessionRuntimePaths(
    runtimePaths,
    sessionId,
  ).cancelMarkerPath;
  const record: SessionCancelRecord = {
    sessionId,
    requestedAt: toIsoTimestamp(),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
  await writeFile(markerPath, JSON.stringify(record), {
    mode: runtimeFileMode,
  });
  return record;
}

/** Read a session cancel marker if one has been requested. */
export async function readSessionCancel(
  projectRoot: string,
  sessionId: string,
): Promise<SessionCancelRecord | undefined> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const markerPath = getSessionRuntimePaths(
    runtimePaths,
    sessionId,
  ).cancelMarkerPath;
  if (!(await fileExists(markerPath))) return undefined;
  try {
    const raw = await readFile(markerPath, "utf8");
    return JSON.parse(raw) as SessionCancelRecord;
  } catch (error) {
    throw new RunmarkError(
      "SESSION_CANCEL_MARKER_INVALID",
      `Cancel marker for session ${sessionId} is malformed.`,
      { exitCode: exitCodes.validationFailure, cause: error },
    );
  }
}

/** Lightweight boolean helper used in hot execution paths. */
export async function isSessionCancelled(
  projectRoot: string,
  sessionId: string,
): Promise<boolean> {
  return (await readSessionCancel(projectRoot, sessionId)) !== undefined;
}

/**
 * In-process registry of currently-executing sessions. Used by the CLI to
 * install a SIGINT/SIGTERM handler that translates signals into a cancel
 * marker for each active run (A2: "cancel: onSignal").
 */
type ActiveSessionRecord = { projectRoot: string; sessionId: string };
const activeSessions = new Map<string, ActiveSessionRecord>();

function activeKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}::${sessionId}`;
}

/** Register a session so signal handlers can translate Ctrl-C into cancellation. */
export function registerActiveSession(
  projectRoot: string,
  sessionId: string,
): void {
  activeSessions.set(activeKey(projectRoot, sessionId), {
    projectRoot,
    sessionId,
  });
}

/** Remove a session from the in-process active-session registry. */
export function unregisterActiveSession(
  projectRoot: string,
  sessionId: string,
): void {
  activeSessions.delete(activeKey(projectRoot, sessionId));
}

/** Snapshot of sessions currently executing inside this process. */
export function listActiveSessions(): ActiveSessionRecord[] {
  return Array.from(activeSessions.values());
}

let signalHandlerInstalled = false;
const signalGraceWindowMs = 1500;

/**
 * Install a single process-level signal handler that requests graceful session
 * cancellation before exiting the CLI process.
 */
export function installSignalCancelHandler(
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
): void {
  if (signalHandlerInstalled) return;
  signalHandlerInstalled = true;
  let handling = false;
  for (const signal of signals) {
    process.on(signal, () => {
      if (handling) {
        // Second signal = hard exit (common "Ctrl-C twice" pattern).
        process.exit(130);
        return;
      }
      handling = true;
      const pending = listActiveSessions();
      if (pending.length === 0) {
        process.exit(130);
        return;
      }
      // Write markers and WAIT for them to hit disk before starting the
      // grace window. Previously the 250 ms clock started before writes
      // completed, creating a race on slow filesystems.
      void Promise.allSettled(
        pending.map(({ projectRoot, sessionId }) =>
          requestSessionCancel(projectRoot, sessionId, {
            reason: `received ${signal}`,
            source: "signal",
          }),
        ),
      )
        .then(
          () =>
            // Allow the executor up to signalGraceWindowMs to observe the
            // marker, abort in-flight fetches, flush chunks, and transition
            // the session to `interrupted`. After that we exit; anything
            // still running is surfaced as a diagnostic by the next run.
            new Promise<void>((resolve) => {
              const deadline = setTimeout(resolve, signalGraceWindowMs);
              const checkDrain = (): void => {
                if (listActiveSessions().length === 0) {
                  clearTimeout(deadline);
                  resolve();
                  return;
                }
                setTimeout(checkDrain, 50);
              };
              setTimeout(checkDrain, 50);
            }),
        )
        .finally(() => process.exit(130));
    });
  }
}

/** Test-only: reset the module-level install latch. */
export function __resetSignalHandlerLatchForTests(): void {
  signalHandlerInstalled = false;
}

/** Remove a cancel marker after a fresh run or successful resume acquires control. */
export async function clearSessionCancel(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  assertValidSessionId(sessionId);
  const runtimePaths = await ensureRuntimePaths(projectRoot);
  const markerPath = getSessionRuntimePaths(
    runtimePaths,
    sessionId,
  ).cancelMarkerPath;
  await removeFileIfExists(markerPath);
}

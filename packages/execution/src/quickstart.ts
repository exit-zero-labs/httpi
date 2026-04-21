import { resolve } from "node:path";
import type { ExecutionResult } from "@exit-zero-labs/runmark-contracts";
import { exitCodes, fileExists, RunmarkError } from "@exit-zero-labs/runmark-shared";
import {
  defaultDemoHost,
  defaultDemoPort,
  startDemoServer,
} from "./demo-server.js";
import { initProject } from "./project-init.js";
import type { InitProjectResult } from "./types.js";

// Imported lazily to avoid any circularity with ./index.js during module load.
async function callRunRun(
  runId: string,
  projectRoot: string,
): Promise<ExecutionResult> {
  const { runRun } = await import("./index.js");
  return runRun(runId, { projectRoot });
}

async function callListProjectDefinitions(
  projectRoot: string,
): Promise<{ runs: Array<{ id: string }> }> {
  const { listProjectDefinitions } = await import("./index.js");
  return listProjectDefinitions({ projectRoot });
}

/**
 * End-to-end options accepted by `runmark quickstart`.
 *
 * The quickstart intentionally bundles scaffold + demo + smoke run behind one
 * verb so first-time users reach a green session without coordinating multiple
 * terminals. It stays CLI-friendly by surfacing every side effect through the
 * returned result and never mutating tracked files beyond `initProject`.
 */
export interface QuickstartOptions {
  projectRoot?: string | undefined;
  /** Skip booting the bundled demo server. Useful when the target service is already running. */
  noDemo?: boolean | undefined;
  /** Override the run to execute. Defaults to the project's sole run, else "smoke". */
  runId?: string | undefined;
  /** Demo-server host (defaults to 127.0.0.1). */
  host?: string | undefined;
  /** Demo-server port (defaults to 4318 to match the scaffolded env). */
  port?: number | undefined;
}

export interface QuickstartResult {
  rootDir: string;
  initialized: boolean;
  runId: string;
  demoBaseUrl?: string | undefined;
  init?: InitProjectResult | undefined;
  execution: ExecutionResult;
}

/**
 * Orchestrate a first-run flow: init if needed, start demo, execute the sole run,
 * and tear the demo server down before returning.
 *
 * Any failure along the way still attempts to close the demo server so the port
 * is released for the next invocation.
 */
export async function quickstartProject(
  options: QuickstartOptions = {},
): Promise<QuickstartResult> {
  const rootDir = resolve(options.projectRoot ?? process.cwd());
  const configPath = resolve(rootDir, "runmark", "config.yaml");

  let initialized = false;
  let initResult: InitProjectResult | undefined;
  if (!(await fileExists(configPath))) {
    initResult = await initProject(rootDir);
    initialized = true;
  }

  let demoBaseUrl: string | undefined;
  let demoServer: Awaited<ReturnType<typeof startDemoServer>>["server"] | undefined;
  if (!options.noDemo) {
    try {
      const started = await startDemoServer({
        host: options.host ?? defaultDemoHost,
        port: options.port ?? defaultDemoPort,
      });
      demoServer = started.server;
      demoBaseUrl = started.baseUrl;
    } catch (error) {
      if (isAddressInUseError(error)) {
        throw new RunmarkError(
          "QUICKSTART_DEMO_PORT_BUSY",
          `Demo server port ${options.port ?? defaultDemoPort} is already in use. Stop the process using that port, pass --port <n>, or re-run with --no-demo.`,
          { exitCode: exitCodes.validationFailure },
        );
      }
      throw error;
    }
  }

  try {
    if (initialized && demoBaseUrl) {
      await syncScaffoldedEnvBaseUrl(rootDir, demoBaseUrl);
    }
    const runId = await resolveQuickstartRunId(rootDir, options.runId);
    const execution = await callRunRun(runId, rootDir);
    return {
      rootDir,
      initialized,
      runId,
      ...(demoBaseUrl !== undefined ? { demoBaseUrl } : {}),
      ...(initResult !== undefined ? { init: initResult } : {}),
      execution,
    };
  } finally {
    if (demoServer) {
      await new Promise<void>((resolveClose) => {
        demoServer?.close(() => resolveClose());
      });
    }
  }
}

async function resolveQuickstartRunId(
  rootDir: string,
  requestedRunId: string | undefined,
): Promise<string> {
  if (requestedRunId) {
    return requestedRunId;
  }
  const listing = await callListProjectDefinitions(rootDir);
  if (listing.runs.length === 0) {
    throw new RunmarkError(
      "QUICKSTART_NO_RUNS",
      "No runs found. Author one under runmark/runs/ or re-run after `runmark init` scaffolds one.",
      { exitCode: exitCodes.validationFailure },
    );
  }
  if (listing.runs.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length-checked above
    return listing.runs[0]!.id;
  }
  const smokeRun = listing.runs.find((run) => run.id === "smoke");
  if (smokeRun) {
    return smokeRun.id;
  }
  const runList = listing.runs.map((run) => run.id).join(", ");
  throw new RunmarkError(
    "QUICKSTART_RUN_AMBIGUOUS",
    `Multiple runs defined (${runList}). Pass --run <id> to pick one.`,
    { exitCode: exitCodes.validationFailure },
  );
}

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

/**
 * When quickstart boots the demo on a non-default host/port, rewrite the
 * scaffolded dev env so subsequent `runmark run` invocations resolve the same
 * URL. We only touch the file we just scaffolded (`initialized: true`), so
 * projects that already had an env file are left alone.
 */
async function syncScaffoldedEnvBaseUrl(
  rootDir: string,
  baseUrl: string,
): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const envPath = resolve(rootDir, "runmark", "env", "dev.env.yaml");
  let contents: string;
  try {
    contents = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  const updated = contents.replace(
    /(^\s*baseUrl:\s*).+$/m,
    `$1${baseUrl}`,
  );
  if (updated !== contents) {
    await writeFile(envPath, updated, "utf8");
  }
}

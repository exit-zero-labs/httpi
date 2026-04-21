/**
 * Always-on per-session summary writer.
 *
 * Summary artifacts live next to the session's manifest under
 * `runmark/artifacts/history/<sessionId>/summary.json` and `summary.md`, so
 * both humans and CI consumers can grep for a stable location without adding
 * reporter flags.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExecutionResult } from "@exit-zero-labs/runmark-contracts";
import { writeFileAtomic } from "@exit-zero-labs/runmark-shared";
import { buildSessionSummary, formatReporter } from "./reporters.js";

export interface WriteSessionSummaryArtifactsResult {
  summaryJsonPath: string;
  summaryMarkdownPath: string;
}

export async function writeSessionSummaryArtifacts(
  result: ExecutionResult,
): Promise<WriteSessionSummaryArtifactsResult | undefined> {
  const session = result.session;
  if (!session?.artifactManifestPath) {
    return undefined;
  }
  const historyDir = dirname(session.artifactManifestPath);
  await mkdir(historyDir, { recursive: true });

  const summary = buildSessionSummary(result);
  const summaryJsonPath = resolve(historyDir, "summary.json");
  const summaryMarkdownPath = resolve(historyDir, "summary.md");
  await writeFileAtomic(
    summaryJsonPath,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFileAtomic(
    summaryMarkdownPath,
    formatReporter("summary", result).content,
  );
  return { summaryJsonPath, summaryMarkdownPath };
}

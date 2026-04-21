/**
 * Reporter formatters for CLI and CI consumers.
 *
 * The goal is a closed, pure-data vocabulary of reporters that can each be
 * rendered deterministically from a fully redacted `ExecutionResult`. The
 * reporter layer never reaches into HTTP transport or tracked YAML — it only
 * consumes the already-computed session ledger and its diagnostics.
 */
import type {
  EnrichedDiagnostic,
  ExecutionResult,
  SessionRecord,
  SessionStepRecord,
  StepAttemptRecord,
} from "@exit-zero-labs/runmark-contracts";

export type ReporterFormat = "json" | "junit" | "tap" | "github" | "summary";

export interface ReporterArtifact {
  format: ReporterFormat;
  /** Default filename extension (no leading dot). */
  extension: string;
  content: string;
  /** Default base filename (used when the caller does not pick a path). */
  defaultBaseName: string;
}

export interface SessionStepSummary {
  stepId: string;
  kind: SessionStepRecord["kind"];
  state: SessionStepRecord["state"];
  requestId?: string | undefined;
  attempts: number;
  totalDurationMs?: number | undefined;
  status?: number | undefined;
  errorMessage?: string | undefined;
}

export interface SessionSummary {
  sessionId: string;
  runId: string;
  envId: string;
  state: SessionRecord["state"];
  source: SessionRecord["source"];
  createdAt: string;
  updatedAt: string;
  nextStepId?: string | undefined;
  pausedReason?: string | undefined;
  failureReason?: string | undefined;
  totals: {
    steps: number;
    completed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  totalDurationMs: number;
  steps: SessionStepSummary[];
  diagnostics: Array<Pick<EnrichedDiagnostic, "code" | "level" | "message">>;
}

export function buildSessionSummary(result: ExecutionResult): SessionSummary {
  const session = result.session;
  const steps: SessionStepSummary[] = Object.values(session.stepRecords).map(
    buildStepSummary,
  );
  const totalDurationMs = steps.reduce(
    (running, step) => running + (step.totalDurationMs ?? 0),
    0,
  );
  const totals = {
    steps: steps.length,
    completed: steps.filter((step) => step.state === "completed").length,
    failed: steps.filter((step) => step.state === "failed").length,
    skipped: 0,
    pending: steps.filter(
      (step) =>
        step.state === "pending" ||
        step.state === "running" ||
        step.state === "paused" ||
        step.state === "interrupted",
    ).length,
  };
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    envId: session.envId,
    state: session.state,
    source: session.source,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.nextStepId !== undefined ? { nextStepId: session.nextStepId } : {}),
    ...(session.pausedReason !== undefined
      ? { pausedReason: session.pausedReason }
      : {}),
    ...(session.failureReason !== undefined
      ? { failureReason: session.failureReason }
      : {}),
    totals,
    totalDurationMs,
    steps,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      level: diagnostic.level,
      message: diagnostic.message,
    })),
  };
}

function buildStepSummary(step: SessionStepRecord): SessionStepSummary {
  const totalDurationMs = step.attempts.reduce(
    (running, attempt) => running + (attempt.durationMs ?? 0),
    0,
  );
  const lastAttempt: StepAttemptRecord | undefined =
    step.attempts[step.attempts.length - 1];
  const status = lastAttempt?.statusCode;
  const errorMessage = step.errorMessage ?? lastAttempt?.errorMessage;
  return {
    stepId: step.stepId,
    kind: step.kind,
    state: step.state,
    ...(step.requestId !== undefined ? { requestId: step.requestId } : {}),
    attempts: step.attempts.length,
    ...(step.attempts.length > 0 ? { totalDurationMs } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

export function formatReporter(
  format: ReporterFormat,
  result: ExecutionResult,
): ReporterArtifact {
  const summary = buildSessionSummary(result);
  switch (format) {
    case "json":
      return {
        format,
        extension: "json",
        defaultBaseName: "run",
        content: `${JSON.stringify(result, null, 2)}\n`,
      };
    case "summary":
      return {
        format,
        extension: "md",
        defaultBaseName: "summary",
        content: renderMarkdownSummary(summary),
      };
    case "junit":
      return {
        format,
        extension: "xml",
        defaultBaseName: "junit",
        content: renderJUnit(summary),
      };
    case "tap":
      return {
        format,
        extension: "tap",
        defaultBaseName: "run",
        content: renderTap(summary),
      };
    case "github":
      return {
        format,
        extension: "txt",
        defaultBaseName: "github-annotations",
        content: renderGitHubAnnotations(result),
      };
  }
}

function renderMarkdownSummary(summary: SessionSummary): string {
  const lines: string[] = [];
  const stateIcon = stateBadge(summary.state);
  lines.push(`# ${stateIcon} Runmark session ${summary.sessionId}`);
  lines.push("");
  lines.push(`- Run: \`${summary.runId}\` (env \`${summary.envId}\`)`);
  lines.push(`- State: **${summary.state}**`);
  lines.push(
    `- Steps: ${summary.totals.completed}/${summary.totals.steps} completed, ${summary.totals.failed} failed, ${summary.totals.skipped} skipped, ${summary.totals.pending} pending`,
  );
  lines.push(`- Total step duration: ${summary.totalDurationMs}ms`);
  if (summary.nextStepId) {
    lines.push(`- Next step: \`${summary.nextStepId}\``);
  }
  if (summary.pausedReason) {
    lines.push(`- Paused reason: ${summary.pausedReason}`);
  }
  if (summary.failureReason) {
    lines.push(`- Failure reason: ${summary.failureReason}`);
  }
  lines.push("");
  if (summary.steps.length > 0) {
    lines.push("## Steps");
    lines.push("");
    lines.push("| Step | Kind | State | Attempts | Status | Duration |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: |");
    for (const step of summary.steps) {
      lines.push(
        `| \`${step.stepId}\` | ${step.kind} | ${step.state} | ${step.attempts} | ${step.status ?? "—"} | ${step.totalDurationMs ?? 0}ms |`,
      );
    }
    lines.push("");
  }
  if (summary.diagnostics.length > 0) {
    lines.push("## Diagnostics");
    lines.push("");
    for (const diagnostic of summary.diagnostics) {
      lines.push(
        `- **${diagnostic.level.toUpperCase()}** \`${diagnostic.code}\`: ${diagnostic.message}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function stateBadge(state: SessionRecord["state"]): string {
  switch (state) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "paused":
      return "⏸";
    case "interrupted":
      return "⚠";
    default:
      return "•";
  }
}

function renderJUnit(summary: SessionSummary): string {
  const testcases = summary.steps
    .map((step) => renderJUnitTestcase(summary, step))
    .join("\n");
  const totalSeconds = (summary.totalDurationMs / 1000).toFixed(3);
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${xmlEscape(summary.runId)}" tests="${summary.totals.steps}" failures="${summary.totals.failed}" skipped="${summary.totals.skipped}" time="${totalSeconds}" timestamp="${summary.createdAt}">
${testcases}
</testsuite>
`;
}

function renderJUnitTestcase(
  summary: SessionSummary,
  step: SessionStepSummary,
): string {
  const time = ((step.totalDurationMs ?? 0) / 1000).toFixed(3);
  const name = xmlEscape(step.stepId);
  const classname = xmlEscape(summary.runId);
  if (step.state === "failed") {
    const message = xmlEscape(step.errorMessage ?? "Step failed");
    return `  <testcase classname="${classname}" name="${name}" time="${time}"><failure message="${message}">${message}</failure></testcase>`;
  }
  if (step.state !== "completed") {
    return `  <testcase classname="${classname}" name="${name}" time="${time}"><skipped message="${step.state}"/></testcase>`;
  }
  return `  <testcase classname="${classname}" name="${name}" time="${time}"/>`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderTap(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push("TAP version 13");
  lines.push(`1..${summary.totals.steps}`);
  summary.steps.forEach((step, index) => {
    const number = index + 1;
    if (step.state === "failed") {
      lines.push(`not ok ${number} - ${step.stepId}`);
      if (step.errorMessage) {
        lines.push("  ---");
        lines.push(`  message: ${JSON.stringify(step.errorMessage)}`);
        lines.push("  ...");
      }
      return;
    }
    if (step.state !== "completed") {
      lines.push(`ok ${number} - ${step.stepId} # SKIP ${step.state}`);
      return;
    }
    lines.push(`ok ${number} - ${step.stepId}`);
  });
  return `${lines.join("\n")}\n`;
}

function renderGitHubAnnotations(result: ExecutionResult): string {
  const lines: string[] = [];
  for (const diagnostic of result.diagnostics) {
    const level = diagnostic.level === "error" ? "error" : "warning";
    const parts: string[] = [];
    if (diagnostic.file) parts.push(`file=${diagnostic.file}`);
    if (diagnostic.line !== undefined) parts.push(`line=${diagnostic.line}`);
    if (diagnostic.column !== undefined)
      parts.push(`col=${diagnostic.column}`);
    parts.push(`title=${diagnostic.code}`);
    const header = parts.length > 0 ? ` ${parts.join(",")}` : "";
    lines.push(
      `::${level}${header}::${diagnostic.message.replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`,
    );
  }
  if (lines.length === 0) {
    lines.push("::notice::runmark produced no diagnostics.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * MCP adapter for the shared `runmark` engine.
 *
 * Like the CLI entrypoint, this module should stay adapter-thin: validate tool
 * inputs, call execution-package APIs, and normalize responses for MCP clients.
 */
import { isDiagnostic } from "@exit-zero-labs/runmark-contracts";
import {
  cancelSessionRun,
  cleanProjectRuntime,
  describeRequest,
  describeRun,
  explainVariables,
  exportProjectAudit,
  getSessionState,
  getSessionStreamChunks,
  listProjectDefinitions,
  listSessionArtifacts,
  readSessionArtifact,
  resumeSessionRun,
  runRequest,
  runRun,
  validateProject,
} from "@exit-zero-labs/runmark-execution";
import {
  asRecord,
  coerceErrorMessage,
  exitCodes,
  RunmarkError,
} from "@exit-zero-labs/runmark-shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

// Zod schemas define the stable MCP input/output contracts at the boundary.
const flatValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const overridesSchema = z.record(z.string(), flatValueSchema);
const projectRootSchema = z
  .string()
  .describe("Path to the project root containing runmark/config.yaml.");

// MCP servers are often launched outside the target repository, so every tool
// call must identify the project explicitly instead of relying on server cwd.
const engineOptionsSchema = {
  projectRoot: projectRootSchema,
};

const executionOptionsSchema = {
  ...engineOptionsSchema,
  envId: z.string().optional(),
  overrides: overridesSchema.optional(),
};

const diagnosticSchema = z.object({
  level: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  hint: z.string(),
  file: z.string(),
  filePath: z.string(),
  line: z.number(),
  column: z.number(),
  path: z.string().optional(),
});

const definitionSummarySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  filePath: z.string(),
});

const sessionStateSchema = z.enum([
  "created",
  "running",
  "paused",
  "failed",
  "completed",
  "interrupted",
]);

const cleanableSessionStateSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
]);

const stepKindSchema = z.enum([
  "request",
  "parallel",
  "pause",
  "pollUntil",
  "switch",
]);

const stepStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "paused",
  "interrupted",
]);

const sessionSummarySchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  envId: z.string(),
  state: sessionStateSchema,
  nextStepId: z.string().optional(),
  updatedAt: z.string(),
});

const variableExplanationSchema = z.object({
  name: z.string(),
  value: flatValueSchema.optional(),
  source: z.enum([
    "override",
    "step",
    "run",
    "request",
    "env",
    "config",
    "secret",
    "process-env",
  ]),
  secret: z.boolean().optional(),
});

const artifactEntrySchema = z.object({
  schemaVersion: z.number(),
  sessionId: z.string(),
  stepId: z.string(),
  attempt: z.number(),
  kind: z.enum([
    "request",
    "body",
    "stream.chunks",
    "stream.assembled",
    "response.binary",
  ]),
  relativePath: z.string(),
  contentType: z.string().optional(),
});

const listDefinitionsOutputSchema = {
  rootDir: z.string().optional(),
  requests: z.array(definitionSummarySchema).optional(),
  runs: z.array(definitionSummarySchema).optional(),
  envs: z.array(definitionSummarySchema).optional(),
  sessions: z.array(sessionSummarySchema).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const validateProjectOutputSchema = {
  rootDir: z.string().optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const describeRequestOutputSchema = {
  requestId: z.string().optional(),
  envId: z.string().optional(),
  request: z.unknown().optional(),
  variables: z.array(variableExplanationSchema).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const describeRunOutputSchema = {
  runId: z.string().optional(),
  envId: z.string().optional(),
  title: z.string().optional(),
  steps: z.array(z.unknown()).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const executionOutputSchema = {
  session: z.unknown().optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const artifactListOutputSchema = {
  sessionId: z.string().optional(),
  artifacts: z.array(artifactEntrySchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const streamChunkSchema = z.object({
  seq: z.number(),
  tOffsetMs: z.number(),
  bytes: z.number(),
  preview: z.string(),
});

const streamChunksOutputSchema = {
  sessionId: z.string().optional(),
  stepId: z.string().optional(),
  attempt: z.number().optional(),
  relativePath: z.string().optional(),
  totalChunks: z.number().optional(),
  chunks: z.array(streamChunkSchema).optional(),
  range: z.object({ start: z.number(), end: z.number() }).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const artifactReadOutputSchema = {
  sessionId: z.string().optional(),
  relativePath: z.string().optional(),
  contentType: z.string().optional(),
  text: z.string().optional(),
  base64: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const explainVariablesOutputSchema = {
  targetId: z.string().optional(),
  envId: z.string().optional(),
  variables: z.array(variableExplanationSchema).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const auditExportSessionSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  envId: z.string(),
  state: sessionStateSchema,
  nextStepId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pausedReason: z.string().optional(),
  failureReason: z.string().optional(),
  artifactManifestPath: z.string(),
  eventLogPath: z.string(),
  artifactCounts: z.object({
    request: z.number(),
    body: z.number(),
    streamChunks: z.number(),
    streamAssembled: z.number(),
    responseBinary: z.number(),
  }),
  artifacts: z.array(artifactEntrySchema),
  steps: z.array(
    z.object({
      stepId: z.string(),
      kind: stepKindSchema,
      state: stepStateSchema,
      requestId: z.string().optional(),
      attempts: z.array(z.unknown()),
    }),
  ),
});

const auditExportSuccessOutputSchema = z.object({
  schemaVersion: z.number(),
  generatedAt: z.string(),
  rootDir: z.string(),
  sessions: z.array(auditExportSessionSchema),
});

const auditExportOutputSchema = {
  // Success-path fields stay optional here because MCP tool errors share the
  // same structuredContent envelope and only include { code, message }.
  schemaVersion: auditExportSuccessOutputSchema.shape.schemaVersion.optional(),
  generatedAt: auditExportSuccessOutputSchema.shape.generatedAt.optional(),
  rootDir: auditExportSuccessOutputSchema.shape.rootDir.optional(),
  sessions: auditExportSuccessOutputSchema.shape.sessions.optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

const cleanRuntimeOutputSchema = {
  rootDir: z.string().optional(),
  dryRun: z.boolean().optional(),
  candidateSessionIds: z.array(z.string()).optional(),
  removedSessionIds: z.array(z.string()).optional(),
  keptSessionIds: z.array(z.string()).optional(),
  skipped: z
    .array(
      z.object({
        sessionId: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  removedPaths: z.array(z.string()).optional(),
  removedReports: z.boolean().optional(),
  removedSecrets: z.boolean().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};

/** Create the stdio MCP server and register the public `runmark` tool surface. */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "runmark",
    version: packageJson.version,
  });

  server.registerTool(
    "list_definitions",
    {
      description:
        "Discover requests, runs, envs, and sessions in an runmark project.",
      inputSchema: {
        ...engineOptionsSchema,
      },
      outputSchema: listDefinitionsOutputSchema,
    },
    async ({ projectRoot }) =>
      handleTool(async () => listProjectDefinitions({ projectRoot })),
  );

  server.registerTool(
    "validate_project",
    {
      description: "Validate tracked runmark definitions and references.",
      inputSchema: {
        ...engineOptionsSchema,
      },
      outputSchema: validateProjectOutputSchema,
    },
    async ({ projectRoot }) =>
      handleTool(async () => validateProject({ projectRoot })),
  );

  server.registerTool(
    "describe_request",
    {
      description: "Resolve a request definition without executing it.",
      inputSchema: {
        requestId: z.string(),
        ...executionOptionsSchema,
      },
      outputSchema: describeRequestOutputSchema,
    },
    async ({ requestId, projectRoot, envId, overrides }) =>
      handleTool(async () =>
        describeRequest(requestId, {
          projectRoot,
          envId,
          overrides,
        }),
      ),
  );

  server.registerTool(
    "describe_run",
    {
      description: "Compile a run definition and show its step graph.",
      inputSchema: {
        runId: z.string(),
        ...executionOptionsSchema,
      },
      outputSchema: describeRunOutputSchema,
    },
    async ({ runId, projectRoot, envId, overrides }) =>
      handleTool(async () =>
        describeRun(runId, {
          projectRoot,
          envId,
          overrides,
        }),
      ),
  );

  server.registerTool(
    "run_definition",
    {
      description:
        "Execute a request or run definition using the shared runmark engine. Provide exactly one of requestId or runId.",
      inputSchema: {
        requestId: z.string().optional(),
        runId: z.string().optional(),
        ...executionOptionsSchema,
      },
      outputSchema: executionOutputSchema,
    },
    async ({ requestId, runId, projectRoot, envId, overrides }) =>
      handleTool(async () => {
        if (requestId && runId) {
          throw new RunmarkError(
            "RUN_TARGET_AMBIGUOUS",
            "Provide either requestId or runId, not both.",
            { exitCode: exitCodes.validationFailure },
          );
        }

        if (requestId) {
          return runRequest(requestId, {
            projectRoot,
            envId,
            overrides,
          });
        }

        if (runId) {
          return runRun(runId, {
            projectRoot,
            envId,
            overrides,
          });
        }

        throw new RunmarkError(
          "RUN_TARGET_REQUIRED",
          "Provide requestId or runId.",
          {
            exitCode: exitCodes.validationFailure,
          },
        );
      }),
  );

  server.registerTool(
    "resume_session",
    {
      description:
        "Resume a paused or failed session if no tracked definition drift is detected.",
      inputSchema: {
        sessionId: z.string(),
        ...engineOptionsSchema,
      },
      outputSchema: executionOutputSchema,
    },
    async ({ sessionId, projectRoot }) =>
      handleTool(async () => resumeSessionRun(sessionId, { projectRoot })),
  );

  server.registerTool(
    "get_session_state",
    {
      description:
        "Read the persisted state and drift diagnostics for a session.",
      inputSchema: {
        sessionId: z.string(),
        ...engineOptionsSchema,
      },
      outputSchema: executionOutputSchema,
    },
    async ({ sessionId, projectRoot }) =>
      handleTool(async () => getSessionState(sessionId, { projectRoot })),
  );

  server.registerTool(
    "list_artifacts",
    {
      description: "List captured artifact paths for a session or one step.",
      inputSchema: {
        sessionId: z.string(),
        stepId: z.string().optional(),
        ...engineOptionsSchema,
      },
      outputSchema: artifactListOutputSchema,
    },
    async ({ sessionId, stepId, projectRoot }) =>
      handleTool(async () =>
        listSessionArtifacts(sessionId, { projectRoot, stepId }),
      ),
  );

  server.registerTool(
    "read_artifact",
    {
      description: "Read a captured artifact from a session.",
      inputSchema: {
        sessionId: z.string(),
        relativePath: z.string(),
        ...engineOptionsSchema,
      },
      outputSchema: artifactReadOutputSchema,
    },
    async ({ sessionId, relativePath, projectRoot }) =>
      handleTool(async () =>
        readSessionArtifact(sessionId, relativePath, { projectRoot }),
      ),
  );

  server.registerTool(
    "cancel_session",
    {
      description:
        "Request cancellation of a session. Writes a cancel marker and transitions runnable sessions to 'interrupted'. Already-captured artifacts are preserved.",
      inputSchema: {
        sessionId: z.string(),
        reason: z.string().optional(),
        ...engineOptionsSchema,
      },
      outputSchema: {
        sessionId: z.string().optional(),
        state: z.string().optional(),
        cancel: z
          .object({
            sessionId: z.string(),
            requestedAt: z.string(),
            reason: z.string().optional(),
            source: z.string().optional(),
          })
          .optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
    },
    async ({ sessionId, reason, projectRoot }) =>
      handleTool(async () =>
        cancelSessionRun(sessionId, {
          projectRoot,
          ...(reason ? { reason } : {}),
          source: "mcp",
        }),
      ),
  );

  server.registerTool(
    "get_stream_chunks",
    {
      description:
        "Read captured streaming chunks (chunks.jsonl) for a given session step. Optional range [start,end) slices the sequence.",
      inputSchema: {
        sessionId: z.string(),
        stepId: z.string(),
        rangeStart: z.number().int().nonnegative().optional(),
        rangeEnd: z.number().int().nonnegative().optional(),
        ...engineOptionsSchema,
      },
      outputSchema: streamChunksOutputSchema,
    },
    async ({ sessionId, stepId, rangeStart, rangeEnd, projectRoot }) =>
      handleTool(async () => {
        const hasRange = rangeStart !== undefined || rangeEnd !== undefined;
        return getSessionStreamChunks(sessionId, stepId, {
          projectRoot,
          ...(hasRange
            ? {
                range: {
                  ...(rangeStart !== undefined ? { start: rangeStart } : {}),
                  ...(rangeEnd !== undefined ? { end: rangeEnd } : {}),
                },
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    "explain_variables",
    {
      description:
        "Explain effective values and provenance for a request or run step. Provide requestId or runId; use stepId with runId to focus one step.",
      inputSchema: {
        requestId: z.string().optional(),
        runId: z.string().optional(),
        stepId: z.string().optional(),
        ...executionOptionsSchema,
      },
      outputSchema: explainVariablesOutputSchema,
    },
    async ({ requestId, runId, stepId, projectRoot, envId, overrides }) =>
      handleTool(async () =>
        explainVariables({
          requestId,
          runId,
          stepId,
          projectRoot,
          envId,
          overrides,
        }),
      ),
  );

  server.registerTool(
    "export_audit_summary",
    {
      description:
        "Export a redacted audit summary for one session or every persisted session in a runmark project.",
      inputSchema: {
        sessionId: z.string().optional(),
        ...engineOptionsSchema,
      },
      outputSchema: auditExportOutputSchema,
    },
    async ({ sessionId, projectRoot }) =>
      handleTool(async () =>
        exportProjectAudit({
          projectRoot,
          sessionId,
        }),
      ),
  );

  server.registerTool(
    "clean_runtime_state",
    {
      description:
        "Remove terminal runtime sessions plus optional reports or global secret files from a runmark project. Supports dry-run, state filters, and retention controls.",
      inputSchema: {
        sessionId: z.string().optional(),
        states: z.array(cleanableSessionStateSchema).optional(),
        keepLast: z.number().int().nonnegative().optional(),
        olderThanDays: z.number().int().nonnegative().optional(),
        includeReports: z.boolean().optional(),
        includeSecrets: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        ...engineOptionsSchema,
      },
      outputSchema: cleanRuntimeOutputSchema,
    },
    async ({
      sessionId,
      states,
      keepLast,
      olderThanDays,
      includeReports,
      includeSecrets,
      dryRun,
      projectRoot,
    }) =>
      handleTool(async () =>
        cleanProjectRuntime({
          projectRoot,
          sessionId,
          states,
          keepLast,
          olderThanDays,
          includeReports,
          includeSecrets,
          dryRun,
        }),
      ),
  );

  return server;
}

/** Start the stdio MCP server used by `runmark mcp`. */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toolResult(result: unknown): {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
} {
  const structuredContent = asRecord(result);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

/** Build a standard MCP error payload with both text and structured content. */
function toolError(
  message: string,
  code = "MCP_TOOL_ERROR",
  details?: unknown,
): {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const payload = buildToolErrorPayload(message, code, details);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: true,
  };
}

/** Wrap a tool action so engine errors become structured MCP error responses. */
async function handleTool(action: () => Promise<unknown>): Promise<{
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}> {
  try {
    return toolResult(await action());
  } catch (error) {
    if (error instanceof RunmarkError) {
      return toolError(error.message, error.code, error.details);
    }

    return toolError(coerceErrorMessage(error), "INTERNAL_ERROR");
  }
}

function buildToolErrorPayload(
  message: string,
  code: string,
  details: unknown,
): Record<string, unknown> {
  if (Array.isArray(details) && details.every(isDiagnostic)) {
    return {
      code,
      message,
      diagnostics: details,
    };
  }

  return {
    code,
    message,
  };
}

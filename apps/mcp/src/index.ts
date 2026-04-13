#!/usr/bin/env node

import { isDiagnostic } from "@exit-zero-labs/httpi-contracts";
import {
  cancelSessionRun,
  describeRequest,
  describeRun,
  explainVariables,
  getSessionState,
  getSessionStreamChunks,
  listProjectDefinitions,
  listSessionArtifacts,
  readSessionArtifact,
  resumeSessionRun,
  runRequest,
  runRun,
  validateProject,
} from "@exit-zero-labs/httpi-execution";
import {
  asRecord,
  coerceErrorMessage,
  exitCodes,
  HttpiError,
} from "@exit-zero-labs/httpi-shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

const flatValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const overridesSchema = z.record(z.string(), flatValueSchema);

const engineOptionsSchema = {
  projectRoot: z.string().optional(),
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

const sessionSummarySchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  envId: z.string(),
  state: z.enum(["created", "running", "paused", "failed", "completed"]),
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
  kind: z.enum(["request.summary", "response.meta", "body"]),
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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "httpi",
    version: packageJson.version,
  });

  server.registerTool(
    "list_definitions",
    {
      description:
        "Discover requests, runs, envs, and sessions in the current httpi project.",
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
      description: "Validate tracked httpi definitions and references.",
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
        "Execute a request or run definition using the shared httpi engine. Provide exactly one of requestId or runId.",
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
          throw new HttpiError(
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

        throw new HttpiError(
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

  return server;
}

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
    if (error instanceof HttpiError) {
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

function printUsage(): void {
  const usage = `httpi-mcp

Usage:
  httpi-mcp
  httpi-mcp --help
  httpi-mcp --version

Transport:
  stdio

Core tools:
  list_definitions   Discover requests, runs, envs, and sessions.
  validate_project   Validate tracked definitions and references.
  describe_request   Resolve one request without executing it.
  describe_run       Compile one run and show its step graph.
  run_definition     Execute a request or run (provide requestId or runId, not both).
  resume_session     Resume a paused or failed session after drift checks.
  get_session_state  Read persisted session state and drift details.
  list_artifacts     List captured artifacts for a session or one step.
  read_artifact      Read one captured artifact with redaction applied.
  get_stream_chunks  Read captured stream chunks (chunks.jsonl) for a session step, with optional range.
  cancel_session     Request cancellation of a session; transitions runnable sessions to 'interrupted'.
  explain_variables  Show effective values and provenance for a request or run step.

Docs:
  - README.md in the repository root for the end-to-end workflow
  - docs/agent-guide.md for agent-specific usage patterns
`;

  process.stdout.write(`${usage}\n`);
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      printUsage();
      return;
    }

    if (
      (argv.length === 1 && argv[0] === "version") ||
      argv[0] === "--version" ||
      argv[0] === "-v"
    ) {
      process.stdout.write(`${packageJson.version}\n`);
      return;
    }

    await startMcpServer();
  } catch (error) {
    if (error instanceof HttpiError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }

    throw error;
  }
}

void main();

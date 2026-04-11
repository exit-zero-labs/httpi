#!/usr/bin/env node

import {
  describeRequest,
  describeRun,
  explainVariables,
  getSessionState,
  listProjectDefinitions,
  listSessionArtifacts,
  readSessionArtifact,
  resumeSessionRun,
  runRequest,
  runRun,
  validateProject,
} from "@exit-zero-labs/httpi-execution";
import {
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
    },
    async ({ sessionId, relativePath, projectRoot }) =>
      handleTool(async () =>
        readSessionArtifact(sessionId, relativePath, { projectRoot }),
      ),
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
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function toolError(
  message: string,
  code = "MCP_TOOL_ERROR",
): {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            code,
            message,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

async function handleTool(action: () => Promise<unknown>): Promise<{
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: true;
}> {
  try {
    return toolResult(await action());
  } catch (error) {
    if (error instanceof HttpiError) {
      return toolError(error.message, error.code);
    }

    return toolError(coerceErrorMessage(error), "INTERNAL_ERROR");
  }
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

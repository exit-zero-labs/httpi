import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadProjectFiles } from "../../packages/definitions/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliEntrypoint = resolve(repoRoot, "apps/cli/dist/index.js");
const exampleRoots = {
  "getting-started": resolve(repoRoot, "examples/getting-started"),
  "pause-resume": resolve(repoRoot, "examples/pause-resume"),
  "api-key-body-file": resolve(repoRoot, "examples/api-key-body-file"),
};

test("public examples validate cleanly", async () => {
  for (const [exampleId, projectRoot] of Object.entries(exampleRoots)) {
    const project = await loadProjectFiles(projectRoot);
    assert.equal(
      project.diagnostics.length,
      0,
      `${exampleId} has diagnostics:\n${JSON.stringify(project.diagnostics, null, 2)}`,
    );
  }
});

test("getting-started example validates, describes, and runs", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createExampleProject("getting-started", baseUrl);

  try {
    const validation = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "validate",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRun.code, 0, describeRun.stderr);
    const describedRun = JSON.parse(describeRun.stdout);
    assert.equal(describedRun.steps.length, 1);
    assert.equal(describedRun.steps[0].id, "ping");

    const runResult = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "run",
      "--run",
      "smoke",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "completed");
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("api-key-body-file example validates, runs, and redacts API keys", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createExampleProject("api-key-body-file", baseUrl);

  try {
    const validation = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "validate",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runNodeProcess(process.execPath, [
      cliEntrypoint,
      "describe",
      "--run",
      "submit-order",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRun.code, 0, describeRun.stderr);
    const describedRun = JSON.parse(describeRun.stdout);
    assert.deepEqual(
      describedRun.steps.map((step) => step.id),
      ["create-order", "get-order"],
    );

    const runResult = await runNodeProcess(
      process.execPath,
      [
        cliEntrypoint,
        "run",
        "--run",
        "submit-order",
        "--project-root",
        projectRoot,
      ],
      {
        env: {
          API_TOKEN: "api-token-secret",
        },
      },
    );
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /api-token-secret/);

    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "completed");
    assert.equal(state.lastApiKey, "api-token-secret");
    assert.deepEqual(state.lastCreateBody, {
      sku: "sku_basic",
      quantity: "2",
      note: "Handle with care",
    });

    const requestSummary = JSON.parse(
      await readFile(
        join(
          projectRoot,
          ".httpi",
          "responses",
          execution.session.sessionId,
          "steps",
          "create-order",
          "attempt-1",
          "request.summary.json",
        ),
        "utf8",
      ),
    );
    assert.equal(requestSummary.headers["x-api-key"], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestSummary), /api-token-secret/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function createExampleProject(exampleId, baseUrl) {
  const exampleRoot = exampleRoots[exampleId];
  const projectRoot = await mkdtemp(
    join(tmpdir(), `httpi-example-${exampleId}-`),
  );
  await cp(exampleRoot, projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "httpi", "env", "dev.env.yaml"),
    [
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/exit-zero-labs/httpi/main/packages/contracts/schemas/env.schema.json",
      "schemaVersion: 1",
      "title: Development",
      "values:",
      `  baseUrl: ${baseUrl}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(projectRoot, ".httpi"), { recursive: true });
  return projectRoot;
}

async function startMockServer() {
  const state = {
    lastApiKey: undefined,
    lastCreateBody: undefined,
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const bodyText = await readRequestBody(request);

    if (request.method === "GET" && requestUrl.pathname === "/ping") {
      writeJson(response, 200, { ok: true });
      return;
    }

    const apiKey = request.headers["x-api-key"];
    if (apiKey !== "api-token-secret") {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/orders") {
      const body = JSON.parse(bodyText);
      state.lastApiKey = apiKey;
      state.lastCreateBody = body;
      writeJson(response, 201, {
        id: `ord_${body.sku}`,
        status: "queued",
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/orders/ord_sku_basic"
    ) {
      state.lastApiKey = apiKey;
      writeJson(response, 200, {
        id: "ord_sku_basic",
        status: "queued",
      });
      return;
    }

    writeJson(response, 404, { error: "not-found" });
  });

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine mock server address.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
  };
}

function runNodeProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function readRequestBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolvePromise(body);
    });
    request.on("error", rejectPromise);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

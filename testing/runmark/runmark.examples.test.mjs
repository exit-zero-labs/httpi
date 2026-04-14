import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  "multi-env-smoke": resolve(repoRoot, "examples/multi-env-smoke"),
  "pause-resume": resolve(repoRoot, "examples/pause-resume"),
  "api-key-body-file": resolve(repoRoot, "examples/api-key-body-file"),
  "basic-auth-crud": resolve(repoRoot, "examples/basic-auth-crud"),
  "ecommerce-checkout": resolve(repoRoot, "examples/ecommerce-checkout"),
  "incident-runbook": resolve(repoRoot, "examples/incident-runbook"),
  "failure-recovery": resolve(repoRoot, "examples/failure-recovery"),
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

test("public examples default to the bundled demo server base URL", async () => {
  for (const projectRoot of Object.values(exampleRoots)) {
    const envDir = join(projectRoot, "runmark", "env");
    const envFiles = await readdir(envDir);
    for (const envFile of envFiles) {
      const envYaml = await readFile(join(envDir, envFile), "utf8");
      assert.match(envYaml, /baseUrl: http:\/\/127\.0\.0\.1:4318/);
    }
  }
});

test("getting-started example validates, describes, and runs", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createExampleProject("getting-started", baseUrl);

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runCli([
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

    const runResult = await runCli([
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

test("multi-env-smoke example reuses one run across environments", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createExampleProject("multi-env-smoke", baseUrl);

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runCli([
      "describe",
      "--run",
      "smoke",
      "--env",
      "staging",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRun.code, 0, describeRun.stderr);
    const describedRun = JSON.parse(describeRun.stdout);
    assert.equal(describedRun.steps.length, 1);
    assert.equal(describedRun.steps[0].id, "ping");

    const runResult = await runCli([
      "run",
      "--run",
      "smoke",
      "--env",
      "staging",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "completed");
    assert.equal(
      execution.session.stepOutputs.ping.activeEnvironment,
      "staging",
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("api-key-body-file example validates, runs, and redacts API keys", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createExampleProject("api-key-body-file", baseUrl);

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runCli([
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

    const runResult = await runCli(
      ["run", "--run", "submit-order", "--project-root", projectRoot],
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

    const requestArtifact = await readRequestArtifact(
      projectRoot,
      execution.session.sessionId,
      "create-order",
    );
    assert.equal(requestArtifact.request.headers["x-api-key"], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestArtifact), /api-token-secret/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("basic-auth-crud example uses local secrets and preserves redaction", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createExampleProject("basic-auth-crud", baseUrl);

  try {
    await writeSecretsFile(projectRoot, {
      adminPassword: "swordfish",
    });

    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const runResult = await runCli([
      "run",
      "--run",
      "crud",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /swordfish/);

    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "completed");
    assert.equal(
      execution.session.stepOutputs["verify-item"].itemStatus,
      "active",
    );

    const itemId = execution.session.stepOutputs["create-item"].itemId;
    assert.deepEqual(state.basicItems.get(itemId), {
      id: itemId,
      name: "widget-basic",
      status: "active",
    });

    const requestArtifact = await readRequestArtifact(
      projectRoot,
      execution.session.sessionId,
      "create-item",
    );
    assert.equal(requestArtifact.request.headers.authorization, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestArtifact), /swordfish/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ecommerce-checkout example runs end-to-end with body templates", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createExampleProject("ecommerce-checkout", baseUrl);

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const describeRun = await runCli([
      "describe",
      "--run",
      "checkout",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(describeRun.code, 0, describeRun.stderr);
    const describedRun = JSON.parse(describeRun.stdout);
    assert.deepEqual(
      describedRun.steps.map((step) => step.id),
      ["create-cart", "add-item", "checkout-order", "get-order"],
    );

    const runResult = await runCli(
      ["run", "--run", "checkout", "--project-root", projectRoot],
      {
        env: {
          COMMERCE_API_TOKEN: "commerce-token-secret",
        },
      },
    );
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /commerce-token-secret/);

    const execution = JSON.parse(runResult.stdout);
    assert.equal(execution.session.state, "completed");
    assert.equal(
      execution.session.stepOutputs["get-order"].orderStatus,
      "queued",
    );
    assert.equal(state.lastCommerceToken, "commerce-token-secret");
    assert.deepEqual(state.lastCommerceBodies.createCart, {
      customerId: "cust_launch",
    });
    assert.deepEqual(state.lastCommerceBodies.addItem, {
      sku: "sku_checkout",
      quantity: "1",
    });
    assert.deepEqual(state.lastCommerceBodies.checkout, {
      couponCode: "spring-launch",
      shippingNote: "Pack carefully",
    });

    const requestArtifact = await readRequestArtifact(
      projectRoot,
      execution.session.sessionId,
      "checkout-order",
    );
    assert.equal(requestArtifact.request.headers["x-api-key"], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestArtifact), /commerce-token-secret/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("incident-runbook example pauses before restart and resumes cleanly", async () => {
  const { server, baseUrl, state } = await startMockServer();
  const projectRoot = await createExampleProject("incident-runbook", baseUrl);
  const resumeEnv = {
    OPS_API_KEY: "ops-token-secret",
  };

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const runResult = await runCli(
      [
        "run",
        "--run",
        "investigate-and-restart",
        "--project-root",
        projectRoot,
      ],
      { env: resumeEnv },
    );
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.doesNotMatch(runResult.stdout, /ops-token-secret/);

    const pausedExecution = JSON.parse(runResult.stdout);
    assert.equal(pausedExecution.session.state, "paused");
    assert.equal(pausedExecution.session.nextStepId, "restart-worker");
    assert.equal(state.restarts.length, 0);

    const requestArtifact = await readRequestArtifact(
      projectRoot,
      pausedExecution.session.sessionId,
      "service-health",
    );
    assert.equal(requestArtifact.request.headers["x-ops-key"], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(requestArtifact), /ops-token-secret/);

    const resumeResult = await runCli(
      [
        "resume",
        pausedExecution.session.sessionId,
        "--project-root",
        projectRoot,
      ],
      { env: resumeEnv },
    );
    assert.equal(resumeResult.code, 0, resumeResult.stderr);

    const resumedExecution = JSON.parse(resumeResult.stdout);
    assert.equal(resumedExecution.session.state, "completed");
    assert.equal(state.restarts.length, 1);
    assert.equal(state.restarts[0].serviceId, "payments-api");
    assert.match(state.restarts[0].reason, /dep_payments-api_42/);
    assert.match(state.restarts[0].reason, /3 alerts open/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("failure-recovery example captures the failed attempt and resumes", async () => {
  const { server, baseUrl } = await startMockServer();
  const projectRoot = await createExampleProject("failure-recovery", baseUrl);

  try {
    const validation = await runCli(["validate", "--project-root", projectRoot]);
    assert.equal(validation.code, 0, validation.stderr);

    const firstRun = await runCli([
      "run",
      "--run",
      "recover-report",
      "--project-root",
      projectRoot,
    ]);
    assert.equal(firstRun.code, 1);

    const failedExecution = JSON.parse(firstRun.stdout);
    assert.equal(failedExecution.session.state, "failed");
    assert.equal(
      failedExecution.session.stepRecords["fetch-report"].attempts.length,
      1,
    );
    assert.equal(
      failedExecution.session.stepRecords["fetch-report"].attempts[0].statusCode,
      503,
    );

    const failedArtifact = await readRequestArtifact(
      projectRoot,
      failedExecution.session.sessionId,
      "fetch-report",
    );
    assert.equal(failedArtifact.outcome, "failed");
    assert.equal(failedArtifact.response.received, true);
    assert.equal(failedArtifact.response.status, 503);

    const resumedRun = await runCli([
      "resume",
      failedExecution.session.sessionId,
      "--project-root",
      projectRoot,
    ]);
    assert.equal(resumedRun.code, 0, resumedRun.stderr);

    const resumedExecution = JSON.parse(resumedRun.stdout);
    assert.equal(resumedExecution.session.sessionId, failedExecution.session.sessionId);
    assert.equal(resumedExecution.session.state, "completed");
    assert.equal(
      resumedExecution.session.stepRecords["fetch-report"].attempts.length,
      2,
    );
    assert.equal(
      resumedExecution.session.stepRecords["fetch-report"].attempts[1].outcome,
      "success",
    );
    assert.equal(
      resumedExecution.session.stepOutputs["confirm-report"].reportStatus,
      "ready",
    );
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function createExampleProject(exampleId, baseUrl) {
  const exampleRoot = exampleRoots[exampleId];
  const projectRoot = await mkdtemp(
    join(tmpdir(), `runmark-example-${exampleId}-`),
  );
  await cp(exampleRoot, projectRoot, { recursive: true });
  await rewriteBaseUrlInTree(join(projectRoot, "runmark", "env"), baseUrl);
  return projectRoot;
}

async function rewriteBaseUrlInTree(root, baseUrl) {
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(root, entry.name);

    if (entry.isDirectory()) {
      await rewriteBaseUrlInTree(entryPath, baseUrl);
      continue;
    }

    const content = await readFile(entryPath, "utf8");
    await writeFile(
      entryPath,
      content.replace(/(^\s*baseUrl:\s*).+$/m, `$1${baseUrl}`),
      "utf8",
    );
  }
}

async function writeSecretsFile(projectRoot, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${value}`);
  await writeFile(
    join(projectRoot, "runmark", "artifacts", "secrets.yaml"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

async function readRequestArtifact(projectRoot, sessionId, stepId, attempt = 1) {
  return JSON.parse(
    await readFile(
      join(
        projectRoot,
        "runmark",
        "artifacts",
        "history",
        sessionId,
        "steps",
        stepId,
        `attempt-${attempt}`,
        "request.json",
      ),
      "utf8",
    ),
  );
}

async function startMockServer() {
  const state = {
    lastApiKey: undefined,
    lastCreateBody: undefined,
    basicItems: new Map(),
    commerceCarts: new Map(),
    commerceOrders: new Map(),
    lastCommerceToken: undefined,
    lastCommerceBodies: {
      createCart: undefined,
      addItem: undefined,
      checkout: undefined,
    },
    restarts: [],
    recoveryFailuresRemaining: 1,
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const bodyText = await readRequestBody(request);

    if (request.method === "GET" && requestUrl.pathname === "/ping") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/env/ping") {
      writeJson(response, 200, {
        ok: true,
        environment: requestUrl.searchParams.get("env"),
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/basic/")) {
      if (!hasBasicAuth(request.headers.authorization, "admin", "swordfish")) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/basic/items") {
        const body = parseJsonBody(bodyText);
        const itemId = `itm_${slugify(body.name)}`;
        state.basicItems.set(itemId, {
          id: itemId,
          name: body.name,
          status: body.status,
        });
        writeJson(response, 201, state.basicItems.get(itemId));
        return;
      }

      const basicItemMatch = requestUrl.pathname.match(/^\/basic\/items\/([^/]+)$/);
      if (basicItemMatch) {
        const itemId = basicItemMatch[1];
        const item = state.basicItems.get(itemId);
        if (!item) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        if (request.method === "GET") {
          writeJson(response, 200, item);
          return;
        }

        if (request.method === "PATCH") {
          const body = parseJsonBody(bodyText);
          item.status = body.status;
          writeJson(response, 200, item);
          return;
        }
      }
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/orders"
    ) {
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "api-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const body = parseJsonBody(bodyText);
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
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "api-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      state.lastApiKey = apiKey;
      writeJson(response, 200, {
        id: "ord_sku_basic",
        status: "queued",
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/commerce/")) {
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "commerce-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      state.lastCommerceToken = apiKey;

      if (request.method === "POST" && requestUrl.pathname === "/commerce/carts") {
        const body = parseJsonBody(bodyText);
        const cartId = `cart_${body.customerId}`;
        state.lastCommerceBodies.createCart = body;
        state.commerceCarts.set(cartId, {
          id: cartId,
          customerId: body.customerId,
          items: [],
        });
        writeJson(response, 201, {
          id: cartId,
          status: "open",
        });
        return;
      }

      const addItemMatch = requestUrl.pathname.match(/^\/commerce\/carts\/([^/]+)\/items$/);
      if (request.method === "POST" && addItemMatch) {
        const body = parseJsonBody(bodyText);
        const cartId = addItemMatch[1];
        const cart = state.commerceCarts?.get(cartId);
        if (!cart) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        const lineItem = {
          id: `li_${body.sku}`,
          sku: body.sku,
          quantity: body.quantity,
        };
        cart.items.push(lineItem);
        state.lastCommerceBodies.addItem = body;
        writeJson(response, 201, {
          id: lineItem.id,
          status: "attached",
        });
        return;
      }

      const checkoutMatch = requestUrl.pathname.match(
        /^\/commerce\/carts\/([^/]+)\/checkout$/,
      );
      if (request.method === "POST" && checkoutMatch) {
        const body = parseJsonBody(bodyText);
        const cartId = checkoutMatch[1];
        const cart = state.commerceCarts?.get(cartId);
        if (!cart) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        const firstItem = cart.items[0];
        const orderId = `ord_${cart.customerId}_${firstItem?.sku ?? "empty"}`;
        state.lastCommerceBodies.checkout = body;
        state.commerceOrders.set(orderId, {
          id: orderId,
          status: "queued",
          couponCode: body.couponCode,
          shippingNote: body.shippingNote,
        });
        writeJson(response, 202, {
          order: {
            id: orderId,
          },
        });
        return;
      }

      const orderMatch = requestUrl.pathname.match(/^\/commerce\/orders\/([^/]+)$/);
      if (request.method === "GET" && orderMatch) {
        const order = state.commerceOrders?.get(orderMatch[1]);
        if (!order) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        writeJson(response, 200, order);
        return;
      }
    }

    if (requestUrl.pathname.startsWith("/ops/")) {
      const opsKey = getHeaderValue(request.headers["x-ops-key"]);
      if (opsKey !== "ops-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const serviceHealthMatch = requestUrl.pathname.match(
        /^\/ops\/services\/([^/]+)\/health$/,
      );
      if (request.method === "GET" && serviceHealthMatch) {
        writeJson(response, 200, {
          serviceId: serviceHealthMatch[1],
          state: "degraded",
        });
        return;
      }

      const alertsMatch = requestUrl.pathname.match(/^\/ops\/services\/([^/]+)\/alerts$/);
      if (request.method === "GET" && alertsMatch) {
        writeJson(response, 200, {
          serviceId: alertsMatch[1],
          count: 3,
        });
        return;
      }

      const latestDeployMatch = requestUrl.pathname.match(
        /^\/ops\/services\/([^/]+)\/deployments\/latest$/,
      );
      if (request.method === "GET" && latestDeployMatch) {
        writeJson(response, 200, {
          deployment: {
            id: `dep_${latestDeployMatch[1]}_42`,
            status: "complete",
          },
        });
        return;
      }

      const restartMatch = requestUrl.pathname.match(/^\/ops\/services\/([^/]+)\/restart$/);
      if (request.method === "POST" && restartMatch) {
        const body = parseJsonBody(bodyText);
        const record = {
          id: `rst_${restartMatch[1]}_${state.restarts.length + 1}`,
          serviceId: restartMatch[1],
          reason: body.reason,
        };
        state.restarts.push(record);
        writeJson(response, 202, {
          id: record.id,
          accepted: true,
        });
        return;
      }
    }

    if (requestUrl.pathname === "/recovery/report" && request.method === "GET") {
      if (state.recoveryFailuresRemaining > 0) {
        state.recoveryFailuresRemaining -= 1;
        writeJson(response, 503, {
          error: "upstream-unavailable",
        });
        return;
      }

      writeJson(response, 200, {
        id: "report_daily",
        status: "ready",
      });
      return;
    }

    const recoveryReportMatch = requestUrl.pathname.match(/^\/recovery\/report\/([^/]+)$/);
    if (request.method === "GET" && recoveryReportMatch) {
      writeJson(response, 200, {
        id: recoveryReportMatch[1],
        status: "ready",
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

function runCli(args, options = {}) {
  return runNodeProcess(process.execPath, [cliEntrypoint, ...args], options);
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

function parseJsonBody(bodyText) {
  return bodyText.length === 0 ? {} : JSON.parse(bodyText);
}

function getHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function hasBasicAuth(headerValue, username, password) {
  const header = getHeaderValue(headerValue);
  if (!header?.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
    "utf8",
  );
  return decoded === `${username}:${password}`;
}

function slugify(value) {
  return value
    .replaceAll(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

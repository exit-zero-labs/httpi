import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVariableExplanationsForTesting,
  extractStepOutputsForTesting,
  redactSessionForOutputForTesting,
  resolveTemplateValueForTesting,
} from "../../packages/execution/dist/index.js";
import { HttpiError, exitCodes, redactedValue } from "../../packages/shared/dist/index.js";
import { toCliFailure } from "../../apps/cli/dist/error.js";

test("explicit and path-derived secret extracts stay tainted", () => {
  const outputs = extractStepOutputsForTesting(
    {
      request: {
        extract: {
          sessionValue: {
            from: "$.token",
            required: true,
            secret: true,
          },
          refreshAlias: {
            from: "$.meta.refreshToken",
            required: true,
          },
          publicName: {
            from: "$.name",
            required: true,
          },
        },
      },
    },
    {
      response: {
        bodyText: JSON.stringify({
          token: "secret-token",
          meta: {
            refreshToken: "refresh-token",
          },
          name: "Ada",
        }),
      },
    },
  );

  assert.deepEqual(outputs.values, {
    sessionValue: "secret-token",
    refreshAlias: "refresh-token",
    publicName: "Ada",
  });
  assert.deepEqual(outputs.secretOutputKeys, ["refreshAlias", "sessionValue"]);
});

test("step secret outputs stay secret during interpolation and explanation", () => {
  const context = createResolutionContext();

  const resolvedSecret = resolveTemplateValueForTesting(
    "{{steps.login.sessionValue}}",
    context,
  );
  assert.equal(resolvedSecret.value, "secret-token");
  assert.deepEqual(resolvedSecret.secretValues, ["secret-token"]);

  const resolvedPublic = resolveTemplateValueForTesting(
    "{{steps.login.userName}}",
    context,
  );
  assert.equal(resolvedPublic.value, "Ada");
  assert.deepEqual(resolvedPublic.secretValues, []);

  const variables = collectVariableExplanationsForTesting(context);
  assert.equal(findVariable(variables, "authToken").secret, true);
  assert.equal(findVariable(variables, "note").secret, false);
  assert.equal(findVariable(variables, "steps.login.sessionValue").secret, true);
  assert.equal(findVariable(variables, "steps.login.userName").secret, false);
});

test("session output redaction honors secret output metadata", () => {
  const redactedSession = redactSessionForOutputForTesting({
    schemaVersion: 1,
    sessionId: "run_123",
    source: "run",
    runId: "smoke",
    envId: "dev",
    state: "paused",
    nextStepId: "touch-user",
    compiled: {
      schemaVersion: 1,
      source: "run",
      runId: "smoke",
      envId: "dev",
      configPath: "/tmp/httpi/config.yaml",
      configHash: "config-hash",
      configDefaults: {},
      capture: {
        requestSummary: true,
        responseMetadata: true,
        responseBody: "full",
        maxBodyBytes: 1024,
        redactHeaders: ["authorization"],
      },
      envPath: "/tmp/httpi/env/dev.env.yaml",
      envHash: "env-hash",
      envValues: {},
      runInputs: {},
      definitionHashes: {},
      steps: [
        {
          kind: "request",
          id: "touch-user",
          requestId: "users/touch-user",
          with: {
            authToken: "{{steps.login.sessionValue}}",
          },
        request: {
          requestId: "users/touch-user",
          filePath: "/tmp/httpi/requests/users/touch-user.request.yaml",
          hash: "request-hash",
          method: "POST",
          url: "{{baseUrl}}/users/{{userId}}/touch",
          defaults: {
            apiToken: "secret-token",
            label: "safe",
          },
          headers: {},
          headerBlocks: [],
          expect: {},
          extract: {},
          },
        },
      ],
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    stepRecords: {
      login: {
        stepId: "login",
        kind: "request",
        requestId: "auth/login",
        state: "completed",
        attempts: [],
        output: {
          sessionValue: "secret-token",
          userName: "Ada",
        },
        secretOutputKeys: ["sessionValue"],
      },
    },
    stepOutputs: {
      login: {
        sessionValue: "secret-token",
        userName: "Ada",
      },
    },
    artifactManifestPath: "/tmp/.httpi/responses/run_123/manifest.json",
    eventLogPath: "/tmp/.httpi/responses/run_123/events.jsonl",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  });

  assert.equal(redactedSession.stepOutputs.login.sessionValue, redactedValue);
  assert.equal(redactedSession.stepOutputs.login.userName, "Ada");
  assert.equal(
    redactedSession.stepRecords.login.output.sessionValue,
    redactedValue,
  );
  assert.equal(redactedSession.stepRecords.login.output.userName, "Ada");
  assert.equal(
    redactedSession.compiled.steps[0].request.defaults.apiToken,
    redactedValue,
  );
  assert.equal(redactedSession.compiled.steps[0].request.defaults.label, "safe");
});

test("CLI failure mapping preserves documented exit codes", () => {
  const validationFailure = toCliFailure(
    new HttpiError("PROJECT_INVALID", "Bad project.", {
      exitCode: exitCodes.validationFailure,
    }),
  );
  assert.deepEqual(validationFailure, {
    message: "Bad project.",
    exitCode: exitCodes.validationFailure,
  });

  const internalFailure = toCliFailure(new Error("boom"));
  assert.deepEqual(internalFailure, {
    message: "boom",
    exitCode: exitCodes.internalError,
  });
});

function createResolutionContext() {
  return {
    projectRoot: "/tmp/httpi",
    compiled: {
      schemaVersion: 1,
      source: "run",
      runId: "smoke",
      envId: "dev",
      configPath: "/tmp/httpi/config.yaml",
      configHash: "config-hash",
      configDefaults: {},
      capture: {
        requestSummary: true,
        responseMetadata: true,
        responseBody: "full",
        maxBodyBytes: 1024,
        redactHeaders: ["authorization"],
      },
      envPath: "/tmp/httpi/env/dev.env.yaml",
      envHash: "env-hash",
      envValues: {},
      runInputs: {},
      definitionHashes: {},
      steps: [],
      createdAt: "2026-04-11T00:00:00.000Z",
    },
    step: {
      kind: "request",
      id: "touch-user",
      requestId: "users/touch-user",
      with: {
        authToken: "{{steps.login.sessionValue}}",
        note: "{{steps.login.userName}}",
      },
      request: {
        requestId: "users/touch-user",
        filePath: "/tmp/httpi/requests/users/touch-user.request.yaml",
        hash: "request-hash",
        method: "POST",
        url: "{{baseUrl}}/users/{{userId}}/touch",
        defaults: {},
        headers: {},
        headerBlocks: [],
        expect: {},
        extract: {},
      },
    },
    stepOutputs: {
      login: {
        sessionValue: "secret-token",
        userName: "Ada",
      },
    },
    secretStepOutputs: {
      login: ["sessionValue"],
    },
    secrets: {},
    processEnv: {},
  };
}

function findVariable(variables, name) {
  const variable = variables.find((entry) => entry.name === name);
  assert.ok(variable, `Expected variable ${name} to exist.`);
  return variable;
}

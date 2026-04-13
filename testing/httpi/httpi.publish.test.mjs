import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("published CLI package is packable and bootable (CLI + MCP subcommand)", async () => {
  await assertPublishablePackage({
    directory: join(repoRoot, "apps/cli/publish"),
    expectedName: "@exit-zero-labs/httpi",
    smokeArgs: ["dist/index.js", "--version"],
    smokeFromManifestVersion: true,
  });
});

async function assertPublishablePackage({
  directory,
  expectedName,
  smokeArgs,
  smokePattern,
  smokeFromManifestVersion,
}) {
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.publishConfig.access, "public");

  const packResult = await runProcess(
    "npm",
    ["pack", "--json", "--dry-run"],
    directory,
  );
  assert.equal(packResult.code, 0, packResult.stderr);
  const [packSummary] = JSON.parse(packResult.stdout);
  assert.equal(packSummary.name, expectedName);
  assert(packSummary.files.some((file) => file.path === "dist/index.js"));
  assert(packSummary.files.some((file) => file.path === "README.md"));
  assert(packSummary.files.some((file) => file.path === "LICENSE"));

  const smokeResult = await runProcess(process.execPath, smokeArgs, directory);
  assert.equal(smokeResult.code, 0, smokeResult.stderr);
  if (smokeFromManifestVersion) {
    assert.equal(smokeResult.stdout.trim(), manifest.version);
  } else {
    assert.match(smokeResult.stdout, smokePattern);
  }

  const installRoot = await mkdtemp(join(tmpdir(), "httpi-install-"));
  try {
    const packedTarball = await runProcess(
      "npm",
      ["pack", "--json"],
      directory,
    );
    assert.equal(packedTarball.code, 0, packedTarball.stderr);
    const [tarballSummary] = JSON.parse(packedTarball.stdout);
    const tarballPath = join(directory, tarballSummary.filename);

    const initResult = await runProcess("npm", ["init", "-y"], installRoot);
    assert.equal(initResult.code, 0, initResult.stderr);

    const installResult = await runProcess(
      "npm",
      ["install", tarballPath],
      installRoot,
    );
    assert.equal(installResult.code, 0, installResult.stderr);

    const [binName] = Object.keys(manifest.bin ?? {});
    assert(binName);

    const binResult = await runProcess(
      join(installRoot, "node_modules", ".bin", binName),
      smokeArgs.slice(1),
      installRoot,
    );
    assert.equal(binResult.code, 0, binResult.stderr);
    if (smokeFromManifestVersion) {
      assert.equal(binResult.stdout.trim(), manifest.version);
    } else {
      assert.match(binResult.stdout, smokePattern);
    }

    await rm(tarballPath, { force: true });
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

function runProcess(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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

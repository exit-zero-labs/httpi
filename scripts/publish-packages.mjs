import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const publishDirectories = [join(repoRoot, "apps/cli/publish")];
const extraArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const isDryRun = extraArgs.includes("--dry-run");

const publishPackages = await Promise.all(
  publishDirectories.map(async (directory) => {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    return {
      directory,
      name: manifest.name,
      version: manifest.version,
      tarballFileName: undefined,
    };
  }),
);

for (const publishPackage of publishPackages) {
  const packResult = await runCommandCapture(
    "npm",
    ["pack", "--json", "--dry-run"],
    {
      cwd: publishPackage.directory,
    },
  );
  if (packResult.code !== 0) {
    throw new Error(
      `npm pack --json --dry-run exited with code ${packResult.code}.`,
    );
  }
  const [packSummary] = JSON.parse(packResult.stdout);
  publishPackage.tarballFileName = packSummary?.filename;
  await removeGeneratedTarballs(publishPackage);
  if (!isDryRun) {
    await assertVersionNotAlreadyPublished(publishPackage);
  }
}

if (isDryRun) {
  // npm pack --dry-run already validated each package above. Skipping
  // `npm publish --dry-run` avoids the registry round-trip that rejects
  // already-published versions in CI.
  process.exit(0);
}

for (const publishPackage of publishPackages) {
  try {
    await runCommand("npm", ["publish", "--access", "public", ...extraArgs], {
      cwd: publishPackage.directory,
    });
  } finally {
    await removeGeneratedTarballs(publishPackage);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function assertVersionNotAlreadyPublished(publishPackage) {
  const result = await runCommandCapture(
    "npm",
    [
      "view",
      `${publishPackage.name}@${publishPackage.version}`,
      "version",
      "--json",
    ],
    {
      cwd: publishPackage.directory,
      allowFailure: true,
    },
  );

  if (result.code === 0 && result.stdout.trim().length > 0) {
    throw new Error(
      `${publishPackage.name}@${publishPackage.version} already exists on npm. Refusing to start a partial release.`,
    );
  }

  if (
    result.code !== 0 &&
    !/E404|404 Not Found|No match found/.test(result.stderr)
  ) {
    throw new Error(
      `Unable to verify npm availability for ${publishPackage.name}@${publishPackage.version}: ${result.stderr.trim()}`,
    );
  }
}

async function removeGeneratedTarballs(publishPackage) {
  if (!publishPackage.tarballFileName) {
    return;
  }

  await Promise.all([
    rm(join(publishPackage.directory, publishPackage.tarballFileName), {
      force: true,
    }),
    rm(join(repoRoot, publishPackage.tarballFileName), { force: true }),
  ]);
}

function runCommandCapture(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise({
          code: code ?? 0,
          stdout,
          stderr,
        });
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

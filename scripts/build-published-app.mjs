import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageDirArgument = process.argv[2];

if (!packageDirArgument) {
  throw new Error("Expected a package directory argument.");
}

const packageDir = resolve(repoRoot, packageDirArgument);
const packageJsonPath = join(packageDir, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const workspacePackages = await loadWorkspacePackages(repoRoot);
const externalDependencies = collectExternalDependencies(
  packageJson.name,
  workspacePackages,
);
const workspaceAliases = Object.fromEntries(
  [...workspacePackages.entries()]
    .filter(
      ([workspacePackageName]) => workspacePackageName !== packageJson.name,
    )
    .map(([workspacePackageName, workspacePackage]) => [
      workspacePackageName,
      join(workspacePackage.directory, "dist/index.js"),
    ]),
);
const entryPoint = join(packageDir, "dist/index.js");
const publishDir = join(packageDir, "publish");
const publishDistDir = join(publishDir, "dist");

await rm(publishDir, { force: true, recursive: true });
await mkdir(publishDistDir, { recursive: true });

await build({
  alias: workspaceAliases,
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  outfile: join(publishDistDir, "index.js"),
  packages: "external",
  platform: "node",
  sourcemap: true,
  target: "node20",
});

const readmeSourcePath = await resolveReadmeSource(packageDir, repoRoot);
await cp(readmeSourcePath, join(publishDir, "README.md"));
await cp(join(repoRoot, "LICENSE"), join(publishDir, "LICENSE"));

const publishManifest = {
  author: packageJson.author,
  bin: packageJson.bin,
  bugs: packageJson.bugs,
  description: packageJson.description,
  dependencies:
    externalDependencies.size > 0
      ? Object.fromEntries(externalDependencies)
      : undefined,
  engines: packageJson.engines,
  exports: packageJson.main ?? undefined,
  files: ["dist", "README.md", "LICENSE"],
  homepage: packageJson.homepage,
  keywords: packageJson.keywords,
  license: packageJson.license,
  main: packageJson.main,
  name: packageJson.name,
  publishConfig: {
    access: packageJson.publishConfig?.access ?? "public",
  },
  repository: normalizeRepository(packageJson.repository),
  type: packageJson.type,
  version: packageJson.version,
};

await writeFile(
  join(publishDir, "package.json"),
  `${JSON.stringify(withoutUndefined(publishManifest), null, 2)}\n`,
);

async function resolveReadmeSource(packageRoot, repositoryRoot) {
  const packageReadme = join(packageRoot, "README.md");
  return existsSync(packageReadme)
    ? packageReadme
    : join(repositoryRoot, "README.md");
}

function collectExternalDependencies(
  packageName,
  workspacePackages,
  visited = new Set(),
  collected = new Map(),
) {
  if (visited.has(packageName)) {
    return collected;
  }

  const workspacePackage = workspacePackages.get(packageName);

  if (!workspacePackage) {
    throw new Error(`Unable to resolve workspace package ${packageName}.`);
  }

  visited.add(packageName);

  for (const [dependencyName, dependencyVersion] of Object.entries(
    workspacePackage.dependencies,
  )) {
    if (dependencyVersion.startsWith("workspace:")) {
      collectExternalDependencies(
        dependencyName,
        workspacePackages,
        visited,
        collected,
      );
      continue;
    }

    collected.set(dependencyName, dependencyVersion);
  }

  return collected;
}

async function loadWorkspacePackages(repositoryRoot) {
  const workspacePackages = new Map();

  for (const directoryName of ["apps", "packages"]) {
    const workspaceRoot = join(repositoryRoot, directoryName);
    const entries = await readdir(workspaceRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspaceDir = join(workspaceRoot, entry.name);
      const manifestPath = join(workspaceDir, "package.json");

      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      workspacePackages.set(manifest.name, {
        directory: workspaceDir,
        dependencies: manifest.dependencies ?? {},
      });
    }
  }

  return workspacePackages;
}

function normalizeRepository(repository) {
  if (!repository) {
    return undefined;
  }

  if (typeof repository === "string") {
    return normalizeRepositoryUrl(repository);
  }

  return {
    ...repository,
    url:
      typeof repository.url === "string"
        ? normalizeRepositoryUrl(repository.url)
        : repository.url,
  };
}

function normalizeRepositoryUrl(url) {
  return url.startsWith("git+") ? url : `git+${url}`;
}

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

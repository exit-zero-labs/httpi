import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const repoRoot = resolve(appRoot, "../..");
const generatedRoot = resolve(appRoot, "src/content/docs/generated");
const repositoryUrl = "https://github.com/exit-zero-labs/httpi";

const pages = [
  {
    sourcePath: "docs/agent-guide.md",
    outputName: "agent-guide.md",
    slug: "guides/agent-guide",
    title: "Agent guide",
    description:
      "Recommended CLI and MCP validation loop for coding agents using httpi.",
  },
  {
    sourcePath: "docs/get-started.md",
    outputName: "contributor-get-started.md",
    slug: "guides/contributor-get-started",
    title: "Contributor setup",
    description:
      "Local development workflow for contributors working in the httpi monorepo.",
  },
  {
    sourcePath: "docs/product.md",
    outputName: "product-overview.md",
    slug: "reference/product-overview",
    title: "Product overview",
    description:
      "What httpi is, who it is for, and how it differs from GUI-first API tooling.",
  },
  {
    sourcePath: "docs/architecture.md",
    outputName: "technical-architecture.md",
    slug: "reference/technical-architecture",
    title: "Technical architecture",
    description:
      "Package ownership, runtime model, and the tracked-vs-runtime filesystem split.",
  },
  {
    sourcePath: "docs/roadmap.md",
    outputName: "roadmap.md",
    slug: "reference/roadmap",
    title: "Roadmap",
    description:
      "Adoption, documentation, and runtime hardening follow-up work for httpi.",
  },
  {
    sourcePath: "docs/support.md",
    outputName: "support.md",
    slug: "reference/support",
    title: "Support",
    description:
      "How the project is funded and how support links are positioned across the repo.",
  },
  {
    sourcePath: "CHANGELOG.md",
    outputName: "changelog.md",
    slug: "reference/changelog",
    title: "Changelog",
    description: "User-visible changes for the current release line.",
  },
];

const sourceToSitePath = new Map([
  ["README.md", "/guides/quickstart/"],
  ["CHANGELOG.md", "/reference/changelog/"],
  ...pages.map((page) => [page.sourcePath, `/${page.slug}/`]),
]);

await rm(generatedRoot, { force: true, recursive: true });
await mkdir(generatedRoot, { recursive: true });

for (const page of pages) {
  const sourceAbsolutePath = resolve(repoRoot, page.sourcePath);
  const outputAbsolutePath = resolve(generatedRoot, page.outputName);
  const sourceText = await readFile(sourceAbsolutePath, "utf8");
  const normalizedText = rewriteLinks(
    stripLeadingHeading(stripFormatComment(sourceText)),
    page.sourcePath,
  );
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `slug: ${JSON.stringify(page.slug)}`,
    "---",
    "",
  ].join("\n");

  await writeFile(
    outputAbsolutePath,
    `${frontmatter}${normalizedText.trimEnd()}\n`,
  );
}

function stripFormatComment(sourceText) {
  return sourceText.replace(/^<!-- @format -->\s*\n+/, "");
}

function stripLeadingHeading(sourceText) {
  return sourceText.replace(/^# [^\n]+\n+/, "");
}

function rewriteLinks(sourceText, sourcePath) {
  const sourceAbsolutePath = resolve(repoRoot, sourcePath);

  return sourceText.replace(
    /(!?)\[([^\]]+)\]\(([^)]+)\)/g,
    (fullMatch, imageMarker, label, rawTarget) => {
      if (imageMarker) {
        return fullMatch;
      }

      const target = rawTarget.trim();

      if (
        target.startsWith("#") ||
        target.startsWith("/") ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        return fullMatch;
      }

      const [targetPath, fragment = ""] = target.split("#", 2);

      if (!targetPath) {
        return fullMatch;
      }

      const resolvedTarget = resolve(dirname(sourceAbsolutePath), targetPath);
      const repoRelativeTarget = toPosixPath(
        relative(repoRoot, resolvedTarget),
      );

      if (repoRelativeTarget.startsWith("..")) {
        return fullMatch;
      }

      const mappedPath = sourceToSitePath.get(repoRelativeTarget);
      const targetUrl = mappedPath
        ? `${mappedPath}${fragment ? `#${fragment}` : ""}`
        : `${toRepositoryUrl(repoRelativeTarget)}${fragment ? `#${fragment}` : ""}`;

      return `[${label}](${targetUrl})`;
    },
  );
}

function toRepositoryUrl(repoRelativePath) {
  const pathType = extname(repoRelativePath) === "" ? "tree" : "blob";
  return `${repositoryUrl}/${pathType}/main/${repoRelativePath}`;
}

function toPosixPath(pathValue) {
  return pathValue.split("\\").join("/");
}

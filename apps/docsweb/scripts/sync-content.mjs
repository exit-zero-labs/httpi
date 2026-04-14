import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const repoRoot = resolve(appRoot, "../..");
const generatedRoot = resolve(appRoot, "src/content/docs/generated");
const repositoryUrl = "https://github.com/exit-zero-labs/runmark";

const pages = [
  {
    sourcePath: "docs/agent-guide.md",
    outputName: "agent-guide.md",
    slug: "guides/agent-guide",
    title: "Agent guide",
    description:
      "Recommended CLI and MCP validation loop for coding agents using Runmark.",
  },
  {
    sourcePath: "docs/get-started.md",
    outputName: "contributor-get-started.md",
    slug: "guides/contributor-get-started",
    title: "Contributor setup",
    description:
      "Local development workflow for contributors working in the Runmark monorepo.",
  },
  {
    sourcePath: "docs/product.md",
    outputName: "what-is-runmark.md",
    slug: "what-is-runmark",
    title: "What is Runmark?",
    description:
      "What Runmark is, who it is for, and how it differs from GUI-first API tooling.",
  },
  {
    sourcePath: "docs/inspect-and-resume.md",
    outputName: "inspect-and-resume.md",
    slug: "guides/inspect-and-resume",
    title: "Inspect + resume",
    description:
      "How paused, failed, and resumed sessions work in practice, including artifact inspection.",
  },
  {
    sourcePath: "docs/examples.md",
    outputName: "examples.md",
    slug: "guides/examples",
    title: "Examples",
    description:
      "Recommended starting order plus the full checked-in example catalog.",
  },
  {
    sourcePath: "docs/ci-and-team-adoption.md",
    outputName: "ci-and-team-adoption.md",
    slug: "guides/ci-and-team-adoption",
    title: "CI and team adoption",
    description:
      "GitHub Actions, PR review, secret handling, and monorepo patterns for Runmark.",
  },
  {
    sourcePath: "docs/security-and-privacy.md",
    outputName: "security-and-privacy.md",
    slug: "trust/security-and-privacy",
    title: "Security and privacy",
    description:
      "What Runmark stores locally, what it redacts, what it does not redact, and how cleanup works.",
  },
  {
    sourcePath: "docs/filesystem-safety.md",
    outputName: "filesystem-safety.md",
    slug: "trust/filesystem-safety",
    title: "Filesystem safety",
    description:
      "Project-root containment, symlink rejection, permissions, and runtime file ownership.",
  },
  {
    sourcePath: "docs/unsafe-resume.md",
    outputName: "unsafe-resume.md",
    slug: "trust/unsafe-resume",
    title: "Unsafe resume and exit code 3",
    description:
      "Why resume can be blocked, what exit code 3 means, and when to start a fresh run.",
  },
  {
    sourcePath: "docs/external-secret-sources.md",
    outputName: "external-secret-sources.md",
    slug: "trust/external-secret-sources",
    title: "External secret sources",
    description:
      "Patterns for environment variables and secret managers in CI or production-style automation.",
  },
  {
    sourcePath: "docs/yaml-reference.md",
    outputName: "yaml-reference.md",
    slug: "reference/yaml-reference",
    title: "YAML reference",
    description:
      "Human-readable reference for config, env, request, run, and block YAML files.",
  },
  {
    sourcePath: "docs/cli-reference.md",
    outputName: "cli-reference.md",
    slug: "reference/cli-reference",
    title: "CLI reference",
    description:
      "Command-level reference for the Runmark CLI, including lifecycle and MCP entrypoints.",
  },
  {
    sourcePath: "docs/outputs-and-runtime-files.md",
    outputName: "outputs-and-runtime-files.md",
    slug: "reference/outputs-and-runtime-files",
    title: "Outputs and runtime files",
    description:
      "Shared CLI/MCP JSON result shapes plus the runtime file layout under runmark/artifacts/.",
  },
  {
    sourcePath: "docs/error-codes.md",
    outputName: "error-codes.md",
    slug: "reference/error-codes",
    title: "Error codes",
    description:
      "Process exit codes plus the user-facing diagnostic and runtime error families.",
  },
  {
    sourcePath: "docs/runmark/brand-foundation.md",
    outputName: "runmark-brand-foundation.md",
    slug: "runmark/brand-foundation",
    title: "Brand foundation",
    description:
      "Runmark product narrative, category framing, differentiation, and brand guardrails.",
  },
  {
    sourcePath: "docs/runmark/voice-and-messaging.md",
    outputName: "runmark-voice-and-messaging.md",
    slug: "runmark/voice-and-messaging",
    title: "Voice and messaging",
    description:
      "Runmark tone, positioning blocks, hero copy, taglines, and approved phrasing.",
  },
  {
    sourcePath: "docs/runmark/visual-system.md",
    outputName: "runmark-visual-system.md",
    slug: "runmark/visual-system",
    title: "Visual system",
    description:
      "Runmark palette, typography, motifs, layout guidance, and visual anti-patterns.",
  },
  {
    sourcePath: "docs/runmark/applications.md",
    outputName: "runmark-applications.md",
    slug: "runmark/applications",
    title: "Applications",
    description:
      "How Runmark should be applied across docs, README, screenshots, and migration surfaces.",
  },
  {
    sourcePath: "docs/runmark/rebrand-transition.md",
    outputName: "runmark-rebrand-transition.md",
    slug: "runmark/rebrand-transition",
    title: "Rebrand transition",
    description:
      "Shipped rename details and migration guidance from httpi to Runmark.",
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
      "Adoption, documentation, and runtime hardening follow-up work for Runmark.",
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

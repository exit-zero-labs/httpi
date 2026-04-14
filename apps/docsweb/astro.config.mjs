// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// biome-ignore lint/style/noDefaultExport: Astro config files must use a default export.
export default defineConfig({
  site: "https://runmark.exitzerolabs.com",
  integrations: [
    starlight({
      title: "Runmark",
      description: "Repo-native HTTP workflows for developers and coding agents.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/exit-zero-labs/runmark",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is Runmark?", slug: "what-is-runmark" },
            { label: "Quickstart", slug: "guides/quickstart" },
            { label: "Inspect + resume", slug: "guides/inspect-and-resume" },
            { label: "Examples", slug: "guides/examples" },
          ],
        },
        {
          label: "Teams & operations",
          items: [
            {
              label: "CI and team adoption",
              slug: "guides/ci-and-team-adoption",
            },
            {
              label: "Security and privacy",
              slug: "trust/security-and-privacy",
            },
            { label: "Filesystem safety", slug: "trust/filesystem-safety" },
            {
              label: "Unsafe resume and exit code 3",
              slug: "trust/unsafe-resume",
            },
            {
              label: "External secret sources",
              slug: "trust/external-secret-sources",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "YAML reference", slug: "reference/yaml-reference" },
            { label: "CLI reference", slug: "reference/cli-reference" },
            {
              label: "Outputs and runtime files",
              slug: "reference/outputs-and-runtime-files",
            },
            { label: "Error codes", slug: "reference/error-codes" },
            {
              label: "Technical architecture",
              slug: "reference/technical-architecture",
            },
            { label: "Changelog", slug: "reference/changelog" },
          ],
        },
        {
          label: "Advanced",
          items: [
            { label: "Agent guide", slug: "guides/agent-guide" },
            { label: "Migrate from httpi", slug: "guides/migrate-from-httpi" },
            { label: "Support", slug: "reference/support" },
            { label: "Roadmap", slug: "reference/roadmap" },
          ],
        },
        {
          label: "Project docs",
          items: [
            {
              label: "Contributor setup",
              slug: "guides/contributor-get-started",
            },
            { label: "Brand foundation", slug: "runmark/brand-foundation" },
            {
              label: "Voice and messaging",
              slug: "runmark/voice-and-messaging",
            },
            { label: "Visual system", slug: "runmark/visual-system" },
            { label: "Applications", slug: "runmark/applications" },
            {
              label: "Rebrand transition",
              slug: "runmark/rebrand-transition",
            },
          ],
        },
      ],
    }),
  ],
});

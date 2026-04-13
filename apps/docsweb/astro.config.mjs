// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// biome-ignore lint/style/noDefaultExport: Astro config files must use a default export.
export default defineConfig({
  site: "https://httpi.exitzerolabs.com",
  integrations: [
    starlight({
      title: "httpi",
      description: "File-based HTTP workflows for humans and AI agents.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/exit-zero-labs/httpi",
        },
      ],
      sidebar: [
        {
          label: "Overview",
          items: [
            { label: "Quickstart", slug: "guides/quickstart" },
            { label: "Product overview", slug: "reference/product-overview" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Agent guide", slug: "guides/agent-guide" },
            {
              label: "Contributor setup",
              slug: "guides/contributor-get-started",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            {
              label: "Technical architecture",
              slug: "reference/technical-architecture",
            },
            { label: "Roadmap", slug: "reference/roadmap" },
            { label: "Support", slug: "reference/support" },
            { label: "Changelog", slug: "reference/changelog" },
          ],
        },
      ],
    }),
  ],
});

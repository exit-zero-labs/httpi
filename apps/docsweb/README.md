# docsweb

Starlight docs site for `httpi`, intended to ship at <https://httpi.exitzerolabs.com>.

## Commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm --filter @exit-zero-labs/httpi-docsweb dev` | start the local docs site |
| `pnpm --filter @exit-zero-labs/httpi-docsweb typecheck` | run Astro type checks |
| `pnpm --filter @exit-zero-labs/httpi-docsweb build` | build the static site |
| `pnpm --filter @exit-zero-labs/httpi-docsweb sync:content` | regenerate synced docs pages from repo sources |

## Content model

- `src/content/docs/index.mdx` and `guides/quickstart.mdx` are hand-authored site pages.
- `scripts/sync-content.mjs` mirrors selected files from the repository root (`docs/*.md` and `CHANGELOG.md`) into `src/content/docs/generated/`.
- Generated content is intentionally Git-ignored so the repo source files remain the canonical edit surface.

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

## Deployment

This site is intended to ship at <https://httpi.exitzerolabs.com> via
Vercel's native Git integration for the monorepo. Keep `apps/docsweb` as the
project root in Vercel and let Vercel handle preview deployments for pull
requests plus production deployments from `main`.

### Vercel project settings

| Setting | Value |
| --- | --- |
| Root Directory | `apps/docsweb` |
| Framework Preset | `Astro` |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm run build` |
| Output Directory | `dist` |
| Node.js Version | `20.19.6` (from repo `.node-version`) |

If you want local CLI access, run `pnpm dlx vercel link` from the repository
root first so Vercel links the monorepo correctly. The generated `.vercel/`
directory is intentionally Git-ignored.

### Custom domain on Cloudflare

1. Add `httpi.exitzerolabs.com` to the Vercel project's **Settings → Domains**
   page.
2. If you are using the CLI for domain setup, run `pnpm dlx vercel link` from
   the repository root once, then run
   `pnpm dlx vercel domains inspect httpi.exitzerolabs.com` to see the exact
   DNS target Vercel expects for the subdomain.
3. In Cloudflare DNS, create a `CNAME` record with name `httpi` and target the
   Vercel-provided value. For a normal subdomain this is usually
   `cname.vercel-dns-0.com`, but use the exact value Vercel shows for the
   project.
4. Keep the Cloudflare record set to **DNS only** until Vercel verifies the
   record and provisions TLS for the domain.
5. Re-run `vercel domains inspect` or use the Vercel UI verify action until
   the domain shows as configured.

## Content model

- `src/content/docs/index.mdx` and `guides/quickstart.mdx` are hand-authored site pages.
- `scripts/sync-content.mjs` mirrors selected files from the repository root (`docs/*.md` and `CHANGELOG.md`) into `src/content/docs/generated/`.
- Generated content is intentionally Git-ignored so the repo source files remain the canonical edit surface.

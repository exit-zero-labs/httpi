<!-- @format -->

# Runmark rebrand transition

**Status**: Internal draft  
**Current implementation name**: `httpi`  
**Target brand**: `Runmark`  
**Companion docs**: [brand foundation](brand-foundation.md), [applications](applications.md)

---

## 1. Purpose

This document scopes the transition from `httpi` to Runmark.

The goal is to separate two concerns clearly:

1. build a coherent Runmark brand/material pack inside the repo now
2. prepare for a later rename of the local folder, GitHub repo, npm package,
   and command surfaces

The rebrand work should not pretend the technical rename has already happened.

## 2. Name mapping

| Surface | Current | Target |
| --- | --- | --- |
| product name | `httpi` | `Runmark` |
| local project folder | `httpi/` | `runmark/` |
| GitHub repo | `exit-zero-labs/httpi` | `exit-zero-labs/runmark` |
| npm package | `@exit-zero-labs/httpi` | `@exit-zero-labs/runmark` |
| binary | `httpi` | `runmark` |
| docs site | `httpi.exitzerolabs.com` | `runmark.exitzerolabs.com` or equivalent final host |

## 3. Transition rule

Until the code/package rename is complete:

- use **Runmark** for brand/material pages
- keep **httpi** for current implementation details
- always explain the relationship when both appear on the same page

Recommended phrasing:

**Runmark (currently implemented as `httpi`)**

## 4. Rename surface categories

The actual rename will touch several distinct layers.

### Product and package metadata

- root `package.json`
- `apps/cli/package.json`
- `apps/docsweb/package.json`
- internal package names such as `@exit-zero-labs/httpi-*`
- npm badges and install instructions

### Documentation and public references

- README
- root `docs/*.md`
- docs site title, description, sidebar, and sync script
- issue templates
- contributor docs
- AI instructions and repo-specific agent guidance

### Implementation-level path assumptions

- project root discovery rules
- references to `httpi/config.yaml`
- references to `httpi/artifacts/`
- examples under `examples/*/httpi/`
- tests that pin current folder names and output paths

### External URLs

- GitHub repository URLs
- docs host
- npm package URLs
- bug tracker and homepage fields

## 5. Recommended migration phases

### Phase 1 - in-repo brand foundation

Ship:

- Runmark product narrative
- Runmark messaging and visual system
- docs-site draft pages
- transition guidance

Do not rename code or package surfaces yet.

### Phase 2 - public docs and copy migration

Update:

- docs site branding
- README and launch copy
- comparison messaging
- rename explanation copy

Keep implementation compatibility notes visible.

### Phase 3 - technical rename

Rename:

- repo
- npm package
- binary
- local folder layout
- docs host
- code references
- examples
- tests

Add temporary compatibility notes or aliases only where they meaningfully lower
migration pain.

### Phase 4 - cleanup

Remove:

- “formerly httpi” notes that have outlived their usefulness
- temporary redirects or aliases that encourage permanent dual naming
- stale docs and obsolete package references

## 6. Guardrails

### Do not let both names live indefinitely

Long-term dual naming creates confusion in:

- docs
- support questions
- package installs
- examples
- agent prompts

### Do not overpromise migration smoothness

Be precise:

- docs and brand migration can happen first
- package, binary, and folder changes are a separate technical step
- compatibility notes should be temporary and explicit

### Do not bury the folder rename

The folder rename from `httpi/` to `runmark/` is product-defining because it
changes:

- project layout examples
- project-root discovery
- docs and screenshots
- user muscle memory

Treat it as a first-class migration item, not a cleanup afterthought.

## 7. Working checklist

### Brand-pack complete when:

- Runmark narrative exists in repo docs
- voice and design guidance exist in repo docs
- docs site has a clear Runmark draft section
- transition notes clearly explain the current `httpi` implementation state

### Rename-prep complete when:

- all rename surface categories are documented
- migration phases are explicit
- no new brand copy assumes the rename has already shipped

## 8. Summary

For now:

- the **brand direction is Runmark**
- the **implementation still says `httpi`**

That split is acceptable only if it is explicit, temporary, and supported by a
clear migration path.

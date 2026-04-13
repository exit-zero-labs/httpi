<!-- @format -->

# Runmark applications

**Status**: Internal draft  
**Current implementation name**: `httpi`  
**Companion docs**: [brand foundation](brand-foundation.md), [voice and messaging](voice-and-messaging.md), [visual system](visual-system.md), [rebrand transition](rebrand-transition.md)

---

## 1. Purpose

This document shows how the Runmark system should be applied across repo-owned
surfaces while the product is still in transition from `httpi`.

The goal is not a full launch package yet. The goal is a contained, coherent
set of in-repo materials that can guide future README, docs site, package, and
rename work.

## 2. Docs site

### Goal

Make the rebrand material feel like a designed draft section, not an orphaned
internal memo.

### Recommended structure

1. Brand foundation
2. Visual system
3. Voice and messaging
4. Applications
5. Rebrand transition

### Page behavior

- use concise intros
- prefer tables over long bullets for rules
- keep draft status obvious
- use card grids for navigation between Runmark pages
- keep code and evidence examples on dark surfaces in both themes

### Example blocks to show

- a hero with one short statement and two CTAs
- tracked intent vs local evidence diagram
- comparison block against GUI clients and request-only tools
- palette table with role guidance
- approved phrases / avoid phrases table

## 3. README and GitHub surface

### Goal

Keep the GitHub entry point honest while the implementation is still named
`httpi`.

### Recommended approach

- keep the existing public README stable until the rename starts
- prepare Runmark-ready copy blocks in repo docs
- when migration begins, update the README in one pass with:
  1. new brand name
  2. clear migration note
  3. current install and compatibility guidance

### README structure for launch

1. `# Runmark`
2. one-paragraph product definition
3. install block
4. what it solves
5. project layout
6. core commands
7. examples
8. migration note from `httpi`

## 4. Product and CLI surfaces

### Goal

Make Runmark feel like a serious tool without over-branding the CLI.

### Guidance

- CLI help should stay neutral and dense
- product pages can carry more serif-led identity
- screenshots should favor:
  - command output
  - file trees
  - saved run state
  - explicit pause/resume moments

### Avoid

- decorative ASCII banners
- marketing-heavy terminal screenshots
- faux dashboards that imply product features that do not exist

## 5. Diagram language

### Preferred diagram sequence

**Tracked files -> Validate -> Run -> Pause -> Inspect saved outputs -> Resume**

### Elements to show repeatedly

- request files
- run files
- `runmark/artifacts/`
- CLI
- MCP
- session record
- saved outputs
- checkpoint

### Avoid

- generic funnel graphics
- “AI agent brain” art
- DAG-heavy orchestration diagrams that make the product look like a workflow engine

## 6. Social, launch, and share surfaces

### Goal

Keep short-form launch material tied to the repo-native workflow story.

### Share-card pattern

- dark background
- one serif statement
- one mono code or path fragment
- one accent mark in Signal
- one checkpoint accent in Ember

### Short-form copy examples

- **Run API workflows from files in your repo.**
- **Tracked definitions. Local evidence. One engine.**
- **Pause, inspect, resume.**

## 7. Rebrand transition labels

While the codebase is still `httpi`, use transition phrasing consistently:

- **Runmark (currently implemented as `httpi`)**
- **Runmark draft**
- **Current command/package names still use `httpi`**

Avoid a split identity where new docs assume the rename is complete but the
actual repo and package surfaces still say `httpi`.

## 8. Application checklist

Use this checklist when applying Runmark later to public surfaces:

| Surface | Must show | Must avoid |
| --- | --- | --- |
| docs site | repo-native job, file tree, workflow loop, draft note if needed | orphaned brand page with no context |
| README | clear product statement, install, migration note | mixed `httpi` and `runmark` without explanation |
| screenshots | files, CLI, saved outputs, explicit state | fake UI or dashboards |
| comparisons | repo files vs workspace, saved outputs vs hidden state | “X killer” framing |
| launch copy | clear rename reason, workflow/evidence story | protocol-only framing |

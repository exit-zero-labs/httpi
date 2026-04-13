<!-- @format -->

# Runmark visual system

**Status**: Internal draft  
**Current implementation name**: `httpi`  
**Companion docs**: [brand foundation](brand-foundation.md), [voice and messaging](voice-and-messaging.md), [applications](applications.md)

---

## 1. Design principles

1. **Tracked, not theatrical**  
   Show intent, state, and evidence clearly. Runmark should feel reliable before
   it feels flashy.
2. **Checkpoint-driven**  
   Visually reinforce flow control: start, branch, pause, inspect, resume,
   complete.
3. **Repo-native clarity**  
   It should look like it belongs in a codebase: structured, inspectable,
   diff-friendly, precise.
4. **Human + agent parity**  
   UI, docs, diagrams, and examples should make CLI and MCP feel like equal
   surfaces of one engine.
5. **Calm confidence**  
   Avoid hacker-neon chaos. Use contrast, rhythm, and restraint.

## 2. Palette

Runmark should inherit the Exit Zero Labs palette but give it product-specific
roles.

| Token | Hex | Runmark role |
| --- | ---: | --- |
| Zero | `#0A0F1E` | primary dark background, code wells, terminal surfaces |
| Dusk | `#1E293B` | elevated surfaces, cards, dark borders, nav |
| Signal | `#00D97E` | primary accent, active run state, success, selected action |
| Ember | `#F97316` | pause/resume checkpoints, human review gates, warnings |
| Canvas | `#FAFAF8` | light reading surfaces, docs backgrounds |
| Mist | `#94A3B8` | secondary text, dividers, inactive UI, metadata |

### Semantic guidance

- **Signal = action + confidence**
- **Ember = intervention + checkpoint**
- **Canvas = reading**
- **Zero = evidence**

### Recommended semantic tokens

- `--rm-bg-dark: #0A0F1E`
- `--rm-surface-dark: #1E293B`
- `--rm-bg-light: #FAFAF8`
- `--rm-text-strong: #0A0F1E`
- `--rm-text-inverse: #FAFAF8`
- `--rm-text-muted: #94A3B8`
- `--rm-accent: #00D97E`
- `--rm-checkpoint: #F97316`

## 3. Typography

### Font stack

- **Headings:** Source Serif 4
- **Body and UI:** Source Sans 3
- **Code and evidence:** JetBrains Mono

### Hierarchy

| Level | Font | Notes |
| --- | --- | --- |
| H1 / hero | Source Serif 4 | category-defining statements, tight leading |
| H2 | Source Serif 4 | section framing, moderate contrast |
| H3 / component heading | Source Sans 3 | utility and scanning |
| Body | Source Sans 3 | reading and interface explanation |
| Labels / chips / nav | Source Sans 3 | 500 weight, tight spacing |
| Commands / paths / IDs / YAML | JetBrains Mono | evidence, not decoration |

### Rule of use

- Serif is for **meaning**
- Sans is for **navigation**
- Mono is for **proof**

## 4. Iconography and motifs

### Preferred motifs

1. **Path + checkpoint** - a line moving through marked stops
2. **Ledger / evidence card** - saved run outputs and session records
3. **Branch + merge** - parallel steps and reconvergence
4. **Pause marker** - explicit inspection gates
5. **Stamped mark** - the visible result a run leaves behind

### Preferred icon family

Use clean technical line icons. Favor:

- play
- pause
- route / workflow
- flag / marker
- terminal
- file-code / file-text
- folder-archive
- history
- git-branch
- check-circle

### Avoid

- rockets
- sparkle / magic motifs
- cloud metaphors
- robot heads
- glossy security shields

## 5. Layout direction

### Docs and landing surfaces

Runmark should use a reading-first technical editorial model:

- generous whitespace
- moderate content width
- dark evidence panels in both themes
- restrained cards
- explicit flow diagrams instead of generic marketing grids

### Recommended structural blocks

1. **Hero** - one sentence, one paragraph, two CTAs
2. **Workflow rail** - Define -> Validate -> Run -> Inspect -> Resume
3. **Tracked intent vs local evidence** split block
4. **CLI / MCP parity** block
5. **Session and saved output** examples
6. **Comparison grid** against adjacent tools
7. **Example repo layout** with real file tree snippets

## 6. Dark and light mode

### Dark mode

Dark mode should be the default brand expression.

- background: Zero
- elevated surfaces: Dusk
- text: Canvas
- secondary text: Mist
- accent: Signal
- checkpoints: Ember

Best for:

- homepage
- product explainers
- code examples
- session and output visuals

### Light mode

Use light mode for long-form reading.

- background: Canvas
- primary text: Zero
- secondary text: Dusk / Mist
- borders: Mist at low contrast
- accent remains Signal

### Critical rule

Keep code blocks and evidence panels dark in both themes. Runtime evidence
should always feel anchored and stable.

## 7. Applications summary

Runmark should present differently across surfaces while keeping the same core
system:

| Surface | Emphasis |
| --- | --- |
| docs site | editorial clarity, compact tables, flow diagrams |
| README | crisp product statement, file tree, command examples |
| CLI screenshots | mono-first, dark surfaces, explicit state labels |
| diagrams | branches, checkpoints, saved outputs, inspect/resume flow |
| social or launch cards | short serif headline + dark terminal/evidence panel |

## 8. Visual anti-patterns

- generic green-on-black terminal branding
- gradient-heavy API-console visuals
- cyberpunk infra dashboard styling
- too many rounded SaaS pills
- blue enterprise sameness
- dense badge walls that look like CI or observability
- security-first iconography that makes Runmark look like a scanner or vault

## 9. Adjacent-product separation

Runmark should not visually blend into:

- **Postman / Hoppscotch** - bright, gradient-heavy API-console energy
- **Bruno / terminal-only tools** - flat utilitarian minimalism without editorial warmth
- **CI dashboards** - status-log walls with no narrative structure
- **AI tooling** - purple-blue glow, abstract intelligence motifs

Runmark should feel like **editorial systems tooling**:

- structured like a codebase
- readable like a field manual
- concrete like an operator surface
- calm enough to trust during real validation work

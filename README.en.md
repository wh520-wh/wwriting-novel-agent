# WWriting Novel Agent

**A local-first desktop agent that manages long-form novel writing like an engineering project.**

WWriting is not a "describe it, it writes it" generator. It is a desktop writing workbench: **open any folder and start chatting** — the agent reads project files, calls tools, and edits chapters and project files on its own, while the application handles orchestration, durable file persistence, state recovery, cost accounting, and permission boundaries. You can watch what the agent is doing at any moment, resume from the journal after an interruption, and every finished chapter is a real file in your own folder. App-private history (sessions, events, checkpoints) lives in the app's data directory, never inside your writing folder.

**Your data stays on your machine. Delivery is verifiable.**

## Highlights

- **Any folder is a workspace**: empty directories, plain material folders, legacy WWriting projects, and non-Git directories all share the same chat entry point — no `project.yaml`, `WWRITING.md`, outline, or chapter directory is required to start chatting.
- **Local project folder persistence**: chapters are written to Markdown/TXT files readable by any editor; a plain folder needs no initialization form before you can start writing.
- **Project memory `WWRITING.md`**: long-lived workspaces keep a viewable, hand-editable project memory at the project root recording current requirements, writing style, and authoritative file indexes; `/init` creates or carefully updates it and no longer generates a fixed blueprint.
- **Objective word-count tool `count_text`**: when the user gives an explicit word-count requirement, the agent may call the tool for real numbers and decide whether to extend, trim, or finish on its own — it is an optional objective tool, not a completion gate.
- **Natural-language review**: review, check, and edit requests go through the same chat flow; the agent reads, judges, and edits directly — there is no separate review mode or `/review` command.
- **Tool-call-only delivery**: the model must deliver chapters through tool calls, with storage-safety checks (path boundary, checksum, atomic writes) — structurally preventing lazy or hallucinated "delivery".
- **Journal recovery**: Session/Run/queue/plan/decision live in the app-private journal; after an interruption or restart you resume from the breakpoint without losing progress.
- **Visible plan**: complex runs show a step-by-step plan that updates as the work progresses and collapses when the run ends.
- **Cross-workspace parallelism**: every workspace has its own session and queue; different workspaces can run in parallel.
- **Deterministic export**: "Export book" reads local files directly — no model call, no extra cost.
- **Cost & cache reports**: tokens, model calls, cost estimates, and provider cache metrics recorded per run.
- **Built-in writing-style skills**: three read-only styles — Balanced, Fast-Readable, Psychological-Literary — ship with the app, viewable but not deletable or editable; selected via natural language or inferred by the model from the premise, then recorded in `WWRITING.md`.
- **Controlled web research**: offline by default; fetched sources are snapshotted and marked as untrusted material, never executed as instructions.
- **OpenAI-compatible model adapters**: official DeepSeek and Xiaomi MiMo presets; paste an API key and go. Keys are stored locally only.
- **Verification culture**: 1400+ unit/integration tests plus a one-command local acceptance suite (`npm run verify:local`) — even UI regressions ("buttons visible but unclickable") are guarded by a real Electron click-through harness.

## Quick Start

### Requirements

- Windows 10/11
- Node.js 24+ (for `npm run desktop:electron`)
- Alternatively, use the packaged desktop installer — no Node environment needed

### Install dependencies

```powershell
npm install
```

### Browser preview

```powershell
npm run app:shell
```

Open the local address printed in the terminal.

### Electron desktop app

```powershell
npm run desktop:electron
```

The desktop app includes a native folder picker: **pick any existing, accessible folder and it opens** — empty directories, plain material folders, and legacy WWriting projects behave the same, and you can send the first message immediately. App-private history is written to the app data directory; no `project.yaml` or `.wwriting/` is created in your folder.

## Usage

1. Launch the desktop app; pick a recent workspace from the left rail, or click "Open Local Folder" to choose any directory.
2. The center area is the single chat surface: type natural-language instructions ("continue chapter 3", "check the character setting") and the agent decides which files to read, which commands to run, and what to edit. For long-lived projects you can ask the agent to run `/init` first to establish `WWRITING.md` project memory. Queued inputs show their original text with a `排队` badge; `立即` interrupts the current run to promote the message, `停止` cancels the current run and clears temporary grants.
3. The settings panel configures: provider, model name, base URL, API key, writing parameters, permission tier, and search endpoint; the "Agent Skills" section shows the three built-in writing styles.
4. Saving settings shows brief "Saved" feedback on the button (no toast); model config is stored in app-private workspace settings (not a `project.yaml`).
5. The top "Panel" button opens the drawer with project facts: chapters and export, model config, research sources, and cost.

Full user guide: [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md) (Chinese).

## Workspace & Project Files (Folder-as-Workspace)

**Any existing, accessible folder is a workspace.** `project.yaml`, `WWRITING.md`, an outline, and a chapter directory are never chat eligibility requirements. App-private history (sessions, events, checkpoints, migration markers) is written under the app data directory's `workspaces/<workspace-id>/` and never appears inside your writing folder.

A long-lived writing project root may contain:

```text
WWRITING.md         # project memory entry: current requirements, writing style,
                    #   authoritative file indexes (viewable and hand-editable)
run_log.jsonl       # domain audit: chapter commits, exports (legacy compat)
cost.json           # model call cost summary
chapters/           # final chapter files
drafts/             # drafts and planning files
memory/             # chapter index and summaries
checkpoints/        # chapter consistency stage snapshots
sources/            # research/fetch source snapshots
skills/             # project skills
OUTLINE.md          # optional: story outline (ordinary authoritative file, indexed by /init)
SETTING.md          # optional: world & setting (ordinary authoritative file, indexed by /init)
AGENTS.md           # optional: project writing instructions (ordinary authoritative file)
```

- `WWRITING.md` is the project-memory entry for each long-lived workspace: the current facts, requirements, progress, and authoritative-file indexes the agent must recover as early as possible in a new conversation. It is **not** a chat database and not a second outline.
- Users may view and hand-edit `WWRITING.md`; the agent is responsible for day-to-day creation, curation, deduplication, and updates. Deleting it means "re-establish the project memory", not "this directory is no longer a workspace".
- Plain folders never get a `project.yaml`; legacy `agent_state.json` / `task_queue.json` files from older versions are migrated once (read-only) on first open and never written again.

## Models & Networking

- Presets: DeepSeek official, Xiaomi MiMo official, custom (OpenAI-compatible).
- API keys are stored in machine-local secrets only and never written into your writing folder; the project only records the environment variable name.
- Networking is off by default; enable "Allow Networking" in settings and configure the search endpoint to use research tools.

## Security Design

- Offline by default; search/fetch adapters are only invoked when configured.
- Web sources are stored as untrusted material, never executed as instructions.
- Plaintext API keys are never written to project config.
- Any accessible folder can be opened as a workspace; in-workspace file access goes through `safeJoin` path-boundary checks and cannot escape the workspace.
- Model text must be committed to drafts via tool calls; objective facts (file existence, word counts, write results) come from tools, not from the model's self-report.
- `count_text` returns objective statistics and gaps only — no pass/fail verdict; word counts are never a completion gate.

## Verification Commands

```powershell
npm test                            # 1400+ unit/integration tests
npm run verify:local                # full local acceptance (includes packaging; slow)
npm run verify:app-shell            # GUI, folder open, settings, skills, research tools
npm run verify:app-clickability     # real Electron window, clicks every critical button
npm run verify:desktop-shell        # Electron security flags, Chinese menus, packaging config
npm run verify:provider-online      # live OpenAI-compatible provider acceptance
npm run verify:research-online      # live web fetch & configurable search acceptance
npm run sim:user-flow               # user-flow simulation (plain folder, /init, style, count_text)
```

## Directory Layout

```text
src/
├─ app-shell/          # desktop GUI frontend (AgentSurface chat surface + navigation)
├─ assets/             # app icon
├─ core/               # agent engine, project storage, model gateway, skills, research tools
└─ desktop/            # Electron main process & preload
scripts/               # verification, packaging, preview scripts
tests/                 # Node test suite
docs/                  # user guide and design docs
```

## Current Status

A locally runnable, verifiable desktop writing agent. Any-folder chatting, project memory, built-in writing styles, objective word-count tooling, skills, research tools, model adapters, GUI, Electron runtime, and Windows packaging all have verification scripts.

Planned enhancements: editable story bible (characters/settings/foreshadowing), skill ecosystem (export/import skill packs), more provider presets, code signing, and auto-update.

## More Docs

- [Chinese README](README.md)
- [User guide (Chinese)](docs/USER_GUIDE.zh-CN.md)

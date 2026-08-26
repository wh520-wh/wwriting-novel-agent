# WWriting Novel Agent

English | [简体中文](README.md)

**A local-first desktop agent that manages long-form novel writing like an engineering project.**

## Current release: v0.5.1

> Eight iterations since v0.4.0 (multi-session, model config rework, plugin-based skills, memory system, kernel partition refactor); full changelog in [CHANGELOG.md](CHANGELOG.md). The architecture below builds on the unified kernel established in v0.4.0; v0.5.0 reworked the internals of the agent kernel, model layer, and front-end controls without changing the public interface.

### Architecture

- **Single backend kernel (ProjectAgent)**: chat loop, writing loop, chapter queue, and stop/resume all live in one deep `ProjectAgent` kernel exposed through a single public interface (`src/core/agent/index.mjs`). v0.5.0 split the kernel into domain modules (runtime / journal / tools / compaction), each guarded by line-count and seam rules.
- **Single front-end surface (AgentSurface)**: chat, work-group items (tool/reasoning entries), visible plan, queued inputs, `立即` (promote) / `停止` (stop), and permission cards converge into one `AgentSurface` (`src/app-shell/agent/index.js`).
- **Journal event sourcing (app-private)**: sessions, runs, queues, plans, decisions, and grants are recorded as events under the app-private workspace directory (`<userData>/workspaces/<workspace-id>/agent/sessions/<session-id>/segments/events/`; one event stream per session, rotatable), never inside the writing folder; `session.json` is a rebuildable projection. Crashes resume from the breakpoint, `立即` promotes a queued message within the same run, and `停止` converges cleanly and clears temporary grants.
- **Permission and security invariants preserved**: read-only auto-execute, confirm before side effects, per-input grants (`本条输入允许同类操作`), YOLO, exact confirmation text for extreme actions, shell process-tree stop, streaming redaction of commands and output — all covered by the acceptance corpus.
- **Own model gateway (ModelGateway)**: retry, timeout, heartbeat, usage, cost accounting, and OpenAI-compatible native function calling live in a clean model layer; provider adapters carry no writing business identity or tool tables.
- **One-time migration, legacy state never rewritten**: `agent_state.json`, `task_queue.json`, `chat_history.jsonl` from old projects are imported once, read-only, on first open (folded into `WWRITING.md` and app-private settings), then never written again; original files stay untouched. Old single-stream/flat conversations also migrate deterministically into "Conversation 1" (`sessions/<id>/`) on first open, immediately visible and continuable.

---

WWriting is not a "describe it and it writes it" generator. It is a desktop writing workbench: **open any folder and start chatting** — the agent reads project files, calls tools, and edits chapters and project files on its own, while the app handles scheduling, disk persistence, state recovery, cost accounting, and permission boundaries. You can watch what the agent is doing at any moment, resume from a breakpoint after an interruption, and every finished chapter is a real file in your folder. App-private history (sessions, events, checkpoints) lives in the app data directory, never in your writing folder.

**Your data stays on your machine. Delivery is verifiable.**

## Highlights

- **Any folder is a workspace**: empty directories, plain material folders, legacy WWriting projects, and Git repos share the same chat entry point; `project.yaml`, `WWRITING.md`, an outline, or a chapter directory is not required to chat.
- **One chat surface**: writing, review, initialization, and questions all start from the same conversation; the agent's state (thinking, reading files, running commands, waiting for confirmation) shows as work-group items in the current round, and queued inputs show their original text with `排队` + `立即`.
- **Local project folder persistence**: chapters are written to Markdown, readable by any editor; a plain folder needs no initialization form to start writing.
- **Project memory `WWRITING.md`**: long-lived workspaces keep a viewable, hand-editable project memory at the project root recording current requirements, writing style, and authoritative file indexes; `/init` creates or carefully updates it, without a fixed blueprint.
- **Objective word-count tool `count_text`**: when the user sets an explicit word-count requirement, the agent can call the tool for real numbers and decide on its own whether to extend, trim, or finish.
- **Natural-language review**: review, check, and edit requests go through ordinary chat; the agent reads, judges, and edits as asked.
- **Tool-call-only delivery**: chapters are written through tool calls; the app checks path boundaries, checksums, and atomicity on every write.
- **Journal breakpoint recovery**: sessions, runs, queues, plans, and decisions are recorded in the app-private directory; after an interruption or restart you continue from the breakpoint without losing progress.
- **Visible plan**: the current run's plan updates as execution proceeds and collapses for review when done.
- **Parallel workspaces**: each workspace has independent sessions and queues; different workspaces can run in parallel.
- **Multiple conversations per project**: the left sidebar lists sessions in a two-level tree per project — create, rename, archive, and restore independent conversations; one project executes serially (one run at a time) so shared state like chapters and memory stays consistent.
- **Deterministic export**: "Export as book" runs a local export pipeline — no model call, no extra cost.
- **Cost & cache reports**: tokens, model calls, cost estimates, and provider cache fields are recorded so you can see what you spent.
- **Built-in skill system (plugin-based)**: 12 writing skills ship as `SKILL.md` — Balanced, Fast-Readable, Psychological-Literary, Avoid-AI-Voice, Payoff Pacing, Dialogue-Driven, Suspense, Detective, Chapter-Opening Hook, Suspenseful Chapter Ending, Dialogue-Not-Summary, Show-Don't-Tell. Skills resolve by directory layers (global / project / user / built-in, four priorities); same-name skills are decided by priority. The chosen style is recorded in `WWRITING.md`.
- **Chapter versions & recovery**: chapters and memory files get version snapshots on every commit (append-only, 200 versions per file); the version timeline panel shows any version and can restore it; writes carry an expected checksum to prevent stale overwrites.
- **Visible context compaction**: when context fills up, compaction is visible and cancellable, and the budget evicts large tool outputs first; the meter shows context usage and cache hit rate live.
- **Visible reasoning**: the model's reasoning streams separately from the body text; thought items show real elapsed time ("thought for N s") and fold up when done.
- **Controlled web research**: offline by default; fetched sources are snapshotted as untrusted material, never executed as instructions.
- **Model config page**: two-level provider/model management (add, enable/disable, set default, delete), model-list pull from providers, inline connection test; presets include official DeepSeek and Xiaomi MiMo, and any OpenAI-compatible gateway works; API keys stay on your machine.
- **Verification culture**: 1953 unit/integration tests all green, plus a one-command local acceptance suite (`npm run verify:local`); even UI regressions like "button visible but unclickable" are caught by a real Electron click-through harness.

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
2. The center area is the single chat surface: type natural-language instructions ("continue chapter 3", "check the character setting") and the agent decides which files to read, which commands to run, and what to edit. For long-lived projects you can ask the agent to run `/init` first to establish `WWRITING.md` project memory.
3. Messages sent while a run is active enter a queue (original text + `排队`); clicking `立即` interrupts the current round and runs this message first without creating a second agent; `停止` cancels the current run and clears temporary grants.
4. Settings configure: provider, model name, base URL, API key, writing parameters, permission tier, and network/search; the "Agent Skills" section lists the writing skills.
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

- Two-level provider/model management: add, enable/disable, set default, delete from the settings page; pull the model list from a provider and test the connection inline.
- Presets: DeepSeek official, Xiaomi MiMo official, custom (OpenAI-compatible).
- API keys are stored in machine-local secrets only and never written into your writing folder; the project only records the environment variable name.
- Networking is off by default; enable "Allow Networking" in settings and configure the search endpoint to use research tools.

## Security Design

- Offline by default; search/fetch adapters are only invoked when configured.
- Web sources are stored as untrusted material, never executed as instructions.
- Plaintext API keys are never written to project config.
- Any accessible folder can be opened as a workspace; in-workspace file access goes through `safeJoin` path-boundary checks and cannot escape the workspace.
- Read-only operations run automatically in the normal permission tier; side effects (writes, deletes, installs, network, launching programs) require confirmation.
- Extreme operations (risk of damaging the disk, system, or large amounts of user data) require you to type the exact confirmation text shown; neither the model nor YOLO can fill it in.
- Chapters must be committed to files through tool calls; objective facts (file existence, word counts, write results) come from tools, not from the model's self-report.
- `count_text` returns objective statistics and gaps only, with no pass/fail verdict.

## Verification Commands

```powershell
npm test                            # 1953 unit/integration tests
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
├─ app-shell/          # desktop GUI frontend (AgentSurface chat surface + navigation + settings + reader)
├─ assets/             # app icon
├─ core/               # agent journal/runtime/tools, project storage, model gateway, skills, research
│  ├─ agent/           #   runtime / journal / compaction / session management / tool registry
│  ├─ model/           #   ModelGateway, capabilities & presets, OpenAI-compatible adapter
│  ├─ skills/          #   skill catalog & loading
│  ├─ project-operations/ # chapter transactions, memory, cost
│  ├─ workspaces/      #   workspace & app-private store
│  └─ http/            #   HTTP routes
├─ desktop/            # Electron main process & preload
├─ shared/             # shared front/back modules (DeepSeek detection, official pricing)
└─ skills/             # built-in writing skills (SKILL.md plugin-based)
scripts/               # verification, packaging, preview scripts
tests/                 # Node test suite
docs/                  # user guide and design docs
```

## Current Status

A locally runnable, verifiable desktop writing agent (v0.5.0). Any-folder chatting, project memory, built-in writing skills, objective word-count tooling, chapter versions and recovery, visible context compaction, two-level provider/model configuration, research tools, GUI, Electron runtime, and Windows packaging all have verification scripts.

Planned enhancements: editable story bible (characters/settings/foreshadowing), skill pack export/import, more provider presets, code signing, and auto-update.

## More Docs

- [Changelog](CHANGELOG.md)
- [User guide (Chinese)](docs/USER_GUIDE.zh-CN.md)
- [简体中文 README](README.md)

# WWriting Novel Agent

**A local-first desktop agent that manages long-form novel writing like an engineering project.**

WWriting is not a "describe it, it writes it" generator. It is a desktop writing workbench: all writing goes through a single chat surface (AgentSurface) — the agent reads project files, calls tools, and edits chapters and blueprints on its own, while the application handles orchestration, durable file persistence, state recovery, word-count verification, cost accounting, and permission boundaries. You can watch what the agent is doing at any moment, resume from the journal after an interruption, and every finished chapter is a real file in your own folder.

**Your data stays on your machine. Delivery is verifiable.**

## Highlights

- **Local project folder persistence**: chapters are written to Markdown/TXT files readable by any editor; an empty folder can be initialized into a new project from the desktop UI.
- **Chapter state machine**: plan → draft → review → revise → finalize → summarize.
- **Real word-count gate**: only locally counted words count; short chapters trigger a rewrite gate, with a failure card offering "write N more words" or "accept current draft".
- **Tool-call-only delivery**: the model must deliver chapters through tool calls; chat messages are rejected — structurally preventing lazy or hallucinated "delivery".
- **Journal recovery**: Session/Run/queue/plan/decision live in the project journal; after an interruption or restart you resume from the breakpoint without losing progress.
- **Visible plan**: complex runs show a step-by-step plan that updates as the work progresses and collapses when the run ends.
- **Cross-project parallelism**: every project has its own session and queue; different projects can run in parallel.
- **Deterministic export**: "Export book" reads local files directly — no model call, no extra cost.
- **Cost & cache reports**: tokens, model calls, cost estimates, and provider cache metrics recorded per run.
- **Skill system**: manifest / hooks / enable / disable / import; ships with a built-in cliffhanger-ending skill.
- **Controlled web research**: offline by default; fetched sources are snapshotted and marked as untrusted material, never executed as instructions.
- **OpenAI-compatible model adapters**: official DeepSeek and Xiaomi MiMo presets; paste an API key and go. Keys are stored locally only.
- **Verification culture**: 900+ unit/integration tests plus a one-command local acceptance suite (`npm run verify:local`) — even UI regressions ("buttons visible but unclickable") are guarded by a real Electron click-through harness.

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

The desktop app includes a native folder picker: open a WWriting project directory containing `project.yaml`, or initialize a new project from an empty folder by entering the novel title, a one-line premise, target chapter count, and minimum words per chapter.

## Usage

1. Launch the desktop app; pick a recent project from the left rail, or click "Open Local Folder".
2. The center area is the single chat surface: type natural-language instructions ("continue chapter 3", "check the character setting") and the agent decides which files to read, which commands to run, and what to edit. Queued inputs show their original text with a `排队` badge; `立即` interrupts the current run to promote the message, `停止` cancels the current run and clears temporary grants.
3. The right settings panel configures: provider, model name, base URL, API key, writing parameters, permission tier, quality gates, and search endpoint.
4. Saving settings shows brief "Saved" feedback on the button (no toast); the config is written to the project's `project.yaml` and recorded in `run_log.jsonl`.
5. The project panel drawer shows project facts: chapters and export, model config, skills, research sources, and cost.

Full user guide: [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md) (Chinese).

## Project Folder (File-as-Project)

A WWriting project directory contains at least:

```text
project.yaml        # project identity, config, blueprint_status
run_log.jsonl       # domain audit: chapter commits, blueprint commits, exports
chapters/           # final chapter files
drafts/             # drafts and planning files
memory/             # chapter index, real word counts, checksums, gate results
checkpoints/        # chapter consistency stage snapshots
sources/            # research/fetch source snapshots
skills/             # project skills
cost.json           # model call cost summary
cache_report.json   # cache keys and provider cache metrics
OUTLINE.md          # blueprint: story outline (created/improved by /init)
SETTING.md          # blueprint: world & setting (created/improved by /init)
AGENTS.md           # project writing instructions (created/improved by /init)
.wwriting/agent/    # agent journal: events.jsonl (source of truth), session.json,
                    #   transcript.jsonl, migration.json (one-time legacy migration)
```

Legacy `agent_state.json` / `task_queue.json` files from older versions are migrated once into the new structure on first open and never written again.

## Models & Networking

- Presets: DeepSeek official, Xiaomi MiMo official, custom (OpenAI-compatible).
- API keys are never written into `project.yaml`; they are stored in machine-local secrets, and the project only records the environment variable name.
- Networking is off by default; enable "Allow Networking" in settings and configure the search endpoint to use research tools.

## Security Design

- Offline by default; search/fetch adapters are only invoked when configured.
- Web sources are stored as untrusted material, never executed as instructions.
- Plaintext API keys are never written to project config.
- Project paths are validated against `project.yaml`; in-project file access goes through `safeJoin`.
- Model text must be committed to drafts via tool calls; chat messages are rejected.
- Word counts are computed locally; the model's self-reported counts are never treated as evidence.

## Verification Commands

```powershell
npm test                            # 900+ unit/integration tests
npm run verify:local                # full local acceptance (includes packaging; slow)
npm run verify:app-shell            # GUI, project open, settings write-back, skills, research tools
npm run verify:app-clickability     # real Electron window, clicks every critical button
npm run verify:desktop-shell        # Electron security flags, Chinese menus, packaging config
npm run verify:provider-online      # live OpenAI-compatible provider acceptance
npm run verify:research-online      # live web fetch & configurable search acceptance
```

## Directory Layout

```text
src/
├─ app-shell/          # desktop GUI frontend (Codex-style three-pane)
├─ assets/             # app icon
├─ core/               # agent engine, project storage, model gateway, skills, research tools
└─ desktop/            # Electron main process & preload
scripts/               # verification, packaging, preview scripts
tests/                 # Node test suite
docs/                  # user guide and design docs
```

## Current Status

A locally runnable, verifiable desktop writing agent. Core long-run generation, recovery, word-count gates, skills, research tools, model adapters, GUI, Electron runtime, and Windows packaging all have verification scripts.

Planned enhancements: editable story bible (characters/settings/foreshadowing), skill ecosystem (export/import skill packs), more provider presets, code signing, and auto-update.

## More Docs

- [Chinese README](README.md)
- [User guide (Chinese)](docs/USER_GUIDE.zh-CN.md)

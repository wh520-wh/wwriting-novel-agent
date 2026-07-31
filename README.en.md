# WWriting Novel Agent

**A local-first desktop agent that manages long-form novel writing like an engineering project.**

WWriting is not a "describe it, it writes it" generator. It is a desktop writing workbench: the application handles orchestration, durable file persistence, state recovery, word-count verification, cost accounting, and permission boundaries — the model only completes one small step at a time. You can watch progress at any moment, resume from a checkpoint after an interruption, and every finished chapter is a real file in your own folder.

**Your data stays on your machine. Delivery is verifiable.**

## How It Differs from Other Tools

AI writing tools on the market fall into two camps: cloud subscription platforms (Sudowrite, NovelCrafter, NovelAI) host your work on their servers, charge monthly fees, and enforce platform content policies; open-source CLI frameworks (novel-bot, Novel-OS, SAGA, etc.) are powerful but require you to set up your own environment and work in a terminal.

WWriting takes a third path:

| Dimension | WWriting | Cloud Subscription Platforms | Open-Source CLI Frameworks |
|---|---|---|---|
| Where your novel lives | **Your local folder** — plain Markdown/TXT files | Cloud servers | Local files |
| Verifiable delivery | **Real word-count gate + tool-call-only commits + read-only inspector** — the model's self-reported word count never counts | Generated means done | Some have quality gates, no hard word-count enforcement |
| Models | **Bring your own API key** — OpenAI-compatible, DeepSeek / Xiaomi MiMo presets, pay per use | Proprietary models, subscription | Bring your own API key |
| Barrier to entry | **Desktop app** — one-click Windows install, fully visual | Web-based, steep learning curve | Terminal + Python environment |
| Privacy & content policy | Offline by default, data never leaves your machine | Platform content moderation | Determined by your model provider |
| Cost transparency | Token and cost recorded per call | Subscription + credits, hard to predict | Not tracked |

In one sentence: **cloud platforms lock your novel into their servers, CLI frameworks put the bar at the terminal — WWriting keeps both your work and its verification on your own computer.**

## Highlights

- **Local project folder persistence**: chapters are written to Markdown/TXT files readable by any editor; an empty folder can be initialized into a new project from the desktop UI.
- **Chapter state machine**: plan → draft → review → revise → finalize → summarize.
- **Real word-count gate**: only locally counted words count; short chapters trigger a rewrite gate, with a failure card offering "write N more words" or "accept current draft".
- **Tool-call-only delivery**: the model must deliver chapters through tool calls; chat messages are rejected — structurally preventing lazy or hallucinated "delivery".
- **Checkpoint resume**: pick up where you left off after an interruption — chapter and stage preserved.
- **Cost & cache reports**: tokens, model calls, cost estimates, and provider cache metrics recorded per run.
- **Skill system**: manifest / hooks / enable / disable / import; ships with a built-in cliffhanger-ending skill.
- **Controlled web research**: offline by default; fetched sources are snapshotted and marked as untrusted material, never executed as instructions.
- **OpenAI-compatible model adapters**: official DeepSeek and Xiaomi MiMo presets; paste an API key and go. Keys are stored locally only.
- **Verification culture**: 54 unit/integration tests plus a one-command local acceptance suite (`npm run verify:local`) — even UI regressions ("buttons visible but unclickable") are guarded by a real Electron click-through harness.

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
2. The center workbench shows: project title and story seed, completed chapters and total valid words, the chapter pipeline, recent run events, skill management, and research/search tools.
3. The right settings panel configures: provider, model name, base URL, API key, max output tokens, max model calls, network permission, and search endpoint.
4. Saving settings shows "Saving / Saved / Error" feedback; the config is written to the project's `project.yaml` and recorded in `run_log.jsonl`.

Full user guide: [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md) (Chinese).

## Project Folder (File-as-Project)

A WWriting project directory contains at least:

```text
project.yaml        # project config, target chapters, model & permission config, enabled skills
agent_state.json    # current chapter, current stage, budget, checkpoint
run_log.jsonl       # event log
chapters/           # final chapter files
drafts/             # drafts and planning files
memory/             # chapter index, real word counts, checksums, gate results
checkpoints/        # resumable stage snapshots
sources/            # research/fetch source snapshots
skills/             # project skills
cost.json           # model call cost summary
cache_report.json   # cache keys and provider cache metrics
```

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
npm test                            # 54 unit/integration tests
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

## Competitive Research

Positioning is based on [docs/research/2026-07-31-competitive-research.md](docs/research/2026-07-31-competitive-research.md): a survey of 9 open-source writing agents (novel-bot, Novel-OS, SAGA, NovelClaw, Openwrite, novel-architect, AI-Novel-Writing-Assistant, and more) plus 3 commercial platforms (Sudowrite, NovelCrafter, NovelAI). Conclusion: **memory/continuity, quality gates, and multi-agent pipelines are industry table stakes — but the combination of a local desktop GUI, file-as-project persistence, and verifiable delivery is unclaimed.**

## Current Status

A locally runnable, verifiable desktop writing agent. Core long-run generation, recovery, word-count gates, skills, research tools, model adapters, GUI, Electron runtime, and Windows packaging all have verification scripts.

Planned enhancements: editable story bible (characters/settings/foreshadowing), skill ecosystem (export/import skill packs), more provider presets, code signing, and auto-update.

## More Docs

- [Chinese README](README.md)
- [User guide (Chinese)](docs/USER_GUIDE.zh-CN.md)
- [Competitive research report](docs/research/2026-07-31-competitive-research.md)

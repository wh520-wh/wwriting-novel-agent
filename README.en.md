<div align="center">

<img src="docs/images/app-icon.png" width="104" alt="WWriting">

# WWriting Novel Agent

**A local-first desktop agent that manages long-form novel writing like an engineering project**

The agent actually reads and writes your files · Every step is verifiable · Your data never leaves your machine

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/wh520-wh/wwriting-novel-agent?color=green)](https://github.com/wh520-wh/wwriting-novel-agent/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)](#quick-start)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-1986%20passing-success)](#development--verification)
[![Stars](https://img.shields.io/github/stars/wh520-wh/wwriting-novel-agent?style=social)](https://github.com/wh520-wh/wwriting-novel-agent/stargazers)

**English** · [简体中文](README.md)

<img src="docs/images/hero.png" width="880" alt="WWriting main interface">

</div>

---

## What this is

WWriting is **not** a "describe it and it writes it" generator.

It is a desktop writing workbench: **open any folder and start chatting**. The agent reads your project files, calls tools, and writes chapters into your folder on its own, while the app handles scheduling, disk persistence, state recovery, cost accounting, and permission boundaries.

You can watch what the agent is doing at any moment. Interrupt it and it resumes from the breakpoint. Every finished chapter is a real Markdown file in your folder — not text in a chat window that you still have to copy out yourself.

> **Your data stays on your machine. Delivery is verifiable.**

<img src="docs/images/agent-working.png" width="880" alt="The agent finishing a writing task: writing a chapter, calling the word-count tool, updating project memory">

## How it differs from typical AI writing tools

|  | Typical AI writing tools | WWriting |
| --- | --- | --- |
| **Deliverable** | Text in a chat box you copy out | Real `.md` chapter files in your folder |
| **Write guarantees** | None | Path boundary + expected checksum + atomic write — structurally hard to fake a delivery |
| **Interruption** | Progress lost, start over | Journal event sourcing; restart and continue from the breakpoint |
| **Length requirements** | The model claims "about 2,000 words" | The model calls `count_text` for an objective count, then decides to extend, trim, or finish |
| **Context** | Errors out or silently truncates | Compaction is visible and cancellable, evicting large tool outputs first |
| **Cost** | Opaque | Per-call tokens, model calls, and cost estimates recorded |
| **Data** | Uploaded to a third-party cloud | Stays entirely on your machine; app-private history never enters your writing folder |
| **Permissions** | All or nothing | Read-only auto / confirm side effects / per-input grants / YOLO / exact confirmation text for extreme actions |
| **Versions** | None | Automatic snapshots of chapters and memory, with a timeline panel to view and restore any version |
| **Verifiability** | Vibes | 1,986 tests plus a full local acceptance suite |

## Core capabilities

### Writing kernel

- **One chat surface**: writing, review, initialization, and questions all start from the same conversation — no mode switching, no workflow picker.
- **Open any folder**: empty directories, plain material folders, legacy projects, and Git repos share the same chat entry point; `project.yaml`, an outline, or a chapter directory is not required to chat.
- **Live visibility**: the agent's state (thinking / reading files / running commands / waiting for confirmation) shows as work-group items in real time; reasoning streams separately from body text, with real elapsed time and folding.
- **Visible plan**: complex tasks show a plan that marks items done as execution proceeds, collapsing for review when the run ends.
- **Queue and interrupt**: messages sent mid-run enter a FIFO queue (original text + `排队`); `立即` interrupts the current round and promotes them, `停止` converges cleanly and clears temporary grants — neither spawns a second agent.
- **Parallel workspaces / multiple conversations**: different workspaces run in parallel; one project can hold multiple independent conversations (two-level sidebar tree) with serialized execution to keep shared state consistent.

### Files and memory

- **Chapters are files**: body text is written to Markdown through tool calls, openable in any editor.
- **Project memory `WWRITING.md`**: one viewable, hand-editable memory file at the project root recording current requirements, writing style, and authoritative file indexes; `/init` creates or carefully updates it without a fixed blueprint.
- **Chapter versions & recovery**: automatic snapshot on every commit (chapters append-only, memory files keep the latest 200 versions), with an expected checksum to prevent stale overwrites.
- **Deterministic export**: "Export as book" runs a local pipeline — no model call, no extra cost.

### Skill system

- **12 built-in writing skills** packaged as `SKILL.md` plugins: Balanced, Fast-Readable, Psychological-Literary, Avoid-AI-Voice, Payoff Pacing, Dialogue-Driven, Suspense, Detective, Chapter-Opening Hook, Suspenseful Chapter Ending, Dialogue-Not-Summary, Show-Don't-Tell.
- **Four-layer precedence**: global / project / user / built-in, resolved by priority; the selection is recorded in `WWRITING.md`.

### Models and safety

- **Two-level provider/model management**: add, enable/disable, set default, and delete from the settings page, with model-list pull and inline connection tests; presets for official DeepSeek and Xiaomi MiMo, and any OpenAI-compatible gateway works.
- **API keys stay on your machine** — never written into the writing folder; project config only records environment-variable names.
- **Offline by default**; fetched web sources are snapshotted as untrusted material and never executed as instructions.
- **Tiered permissions**: read-only operations auto-execute while side effects require confirmation; per-input grants apply only to the current message; YOLO skips ordinary confirmations; extreme actions **always** require the user to type the exact confirmation text — neither the model nor YOLO can fill it in.

## Quick start

### Option 1: installer (recommended)

Download `WWriting.Novel.Agent-0.5.1-Setup.exe` from [Releases](https://github.com/wh520-wh/wwriting-novel-agent/releases). No Node environment needed.

### Option 2: run from source

Requirements: **Windows 10/11** and **Node.js 24 or later**.

```powershell
git clone https://github.com/wh520-wh/wwriting-novel-agent.git
cd wwriting-novel-agent
npm ci

npm run desktop:electron   # launch the Electron desktop app
npm run app:shell          # or: launch the browser preview
```

Once the desktop app is open, pick a recent workspace on the left or click "Open local folder" — **any existing, accessible folder works**. You can send your first message immediately.

For a long-lived project, send this first:

```text
/init
```

The agent creates a `WWRITING.md` project memory so every later conversation can pick up context quickly.

## What a workspace looks like

Any existing, accessible folder can be a workspace. App-private history (sessions, events, checkpoints) is written to the system app-data directory and **never** appears in your writing folder.

```text
WWRITING.md    # Project memory: current requirements, style, authoritative file indexes
正文/           # Chapter files (system-protected)
drafts/        # Drafts and planning
memory/        # Chapter index and summaries
checkpoints/   # Consistency stage snapshots
sources/       # Search/fetch source snapshots
skills/        # Project-level skills
OUTLINE.md     # Optional: story outline
SETTING.md     # Optional: world and settings
```

- `WWRITING.md` is the memory entry point for long-lived workspaces — **not** a chat database and not a second outline. You can read and edit it by hand.
- Deleting it tells the agent to rebuild its memory; it does not mean the folder is no longer a workspace.
- Legacy files such as `agent_state.json` and `task_queue.json` are imported **once, read-only** on first open, then never written again; the originals are left untouched.

## Development & verification

This project treats verifiability as part of the product, not a slogan:

```powershell
npm test                        # 1,986 unit/integration tests
npm run verify:local            # full local acceptance (includes packaging; slow)
npm run verify:app-shell        # GUI, project open, settings, skills, research tools
npm run verify:app-clickability # real Electron window clicking every key button
npm run verify:desktop-shell    # Electron security switches, menus, packaging config
npm run verify:provider-online  # real OpenAI-compatible provider acceptance
npm run verify:research-online  # real web fetch and configurable search acceptance
npm run sim:user-flow           # end-to-end user-flow simulation
```

Even UI regressions like "button visible but unclickable" are caught by a real Electron click-through harness.

> Statistics baseline: recorded 2026-09-14 | status: current | source: `npm test` run (1986/1986, exit 0, two consecutive runs).

## Repository layout

```text
src/
├─ app-shell/             # Desktop GUI front end (chat surface + navigation + settings + reader)
├─ core/
│  ├─ agent/              #   runtime / journal / compaction / sessions and tool registry
│  ├─ model/              #   ModelGateway, capabilities, presets, OpenAI-compatible adapter
│  ├─ skills/             #   Skill directory and loading
│  ├─ project-operations/ #   Chapter transactions, memory, cost
│  ├─ workspaces/         #   Workspaces and private storage
│  └─ http/               #   HTTP routing layer
├─ desktop/               # Electron main process and preload
├─ shared/                # Shared front/back modules
└─ skills/                # Built-in writing skills (SKILL.md)
scripts/                  # Verification, packaging, preview scripts
tests/                    # Node test suites
docs/adr/                 # Architecture decision records
```

## Roadmap

- [ ] Story bible (characters / settings / foreshadowing)
- [ ] Skill pack export and import
- [ ] More provider presets
- [ ] Code signing and auto-update

## Contributing

Issues and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you start.

**Never use `git push --all` or `--mirror` against the public repository** — push only the `main` branch.

For security issues, report privately per [SECURITY.md](SECURITY.md) instead of opening a public issue.

## More documentation

- [Changelog](CHANGELOG.md)
- [Full user guide (Chinese)](docs/USER_GUIDE.zh-CN.md)
- [Architecture decision records](docs/adr/)
- [中文 README](README.md)

## License

[MIT](LICENSE) © 2026 WWriting

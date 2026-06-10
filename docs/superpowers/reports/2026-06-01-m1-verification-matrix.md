# M1 Verification Matrix

## Purpose

This matrix explains which command proves which part of M1 maturity. It is written for both developers and non-specialist reviewers.

## Verification Levels

| Level | Command | What It Proves | When To Run | M1 Gate |
| --- | --- | --- | --- | --- |
| Fast unit/integration | `npm test` | Core behavior, app-shell component tests, queue, event-log, provider adapter tests. | Every task and before review. | Must pass |
| App shell smoke | `npm run verify:app-shell` | Dashboard shell can render a demo project and failure-card whitelist matches. | Before M1 review. | Must pass |
| Clickability | `npm run verify:app-clickability` | Electron UI has clickable primary controls and no obvious blocked workflow. | Before M1 review. | Must pass unless documented non-blocking environment exception |
| Full local | `npm run verify:local` | Local end-to-end verification bundle. | Before M1 completion. | Must pass unless documented non-blocking environment exception |

## Exception Rule

An M1 gate exception is allowed only when all of these are true:

1. The failure is proven to be an environment issue or explicitly accepted non-blocking issue.
2. The report records the exact command, exit status, and failure summary.
3. The report records user impact.
4. The report records the follow-up task or reason no follow-up is needed.

## Failure Classification

| Category | Examples | Owner |
| --- | --- | --- |
| Model | Provider timeout, malformed provider response, retry exhausted. | Backend reliability |
| State | Conflicting project status, bad state file, failed migration. | State/queue |
| Queue | Multiple running tasks, stale running task, retry conflict. | State/queue |
| Event Log | Slow recent-event reads, malformed log lines. | Event log |
| Frontend | Button not clickable, dashboard stale, unclear error. | App shell |
| Packaging | Electron launch, installer, packaged dir. | Release engineering |

## Required Evidence In Delivery Report

- Command run.
- Date and local environment.
- Pass/fail result.
- If failed, exception decision and follow-up.

## Available Commands Confirmed

`npm run` currently lists these M1-relevant commands:

- `test`
- `verify:app-shell`
- `verify:app-clickability`
- `verify:local`


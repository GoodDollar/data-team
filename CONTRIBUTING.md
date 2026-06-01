> ⚠️ **DRAFT — Pending review and approval by GoodDollar leadership.**
> Sections marked `[SUGGESTION]` are proposals open for decision before this document is finalized.

---

# Contributing to data-team

## Overview

`[SUGGESTION]` This repository is the central hub for GoodDollar's data team — queries, pipelines, scripts, and documentation. Contributions are welcome in the form of Pull Requests or via the bounty program described below.

## Tech stack

`[SUGGESTION]` Key technologies used across this repo:

| Area | Technology |
|---|---|
| On-chain data pipeline | TypeScript / Node.js |
| Blockchain indexing | HyperSync (Envio) |
| Data warehouse | BigQuery |
| Analytics / dashboards | Dune Analytics (SQL) |
| Scheduled scripts | Google Apps Script |
| Automation | n8n (archived) |

## Getting started

Each project has its own setup instructions:

- **Events pipeline** — see [projects/gd-events-pipeline/README.md](projects/gd-events-pipeline/README.md)
- **Dashboard scripts** — see [projects/dashboard-scripts/README.md](projects/dashboard-scripts/README.md)

## How to contribute

1. Check [open issues](../../issues) for work that needs doing — look for the `bounty` label for paid tasks
2. Comment on the issue to claim it before starting
3. Fork the repo (or create a branch if you have access)
4. Do your work, commit with clear messages (`feat:`, `fix:`, `docs:`, `chore:`)
5. Open a PR using the PR template — link it to the issue with `Closes #N`
6. Wait for review; address any feedback
7. Once approved and merged, the issue closes automatically

## PR standards

`[SUGGESTION]`

- PRs should be focused — one issue per PR
- Include a clear description of what changed and why
- Tests or verification steps must be described in the PR template
- Code review is required before merging to `master`

## Bounty program

`[SUGGESTION]`

Some issues are tagged with a `bounty` label. These are tasks open for community contributors.

- Bounty amount and payment method are stated in the issue
- To claim: comment on the issue. The data team lead will confirm assignment
- Work is only paid on a successfully merged PR that satisfies the acceptance criteria in the issue
- Payment process: `[SUGGESTION — payment method and platform to be defined by leadership]`

## Questions

Open an issue or reach out to the data team via `[SUGGESTION — preferred contact channel]`.

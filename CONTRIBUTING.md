# Contributing to data-team

## How to request data work

Use the [Data Request issue template](../../issues/new?template=data-request.yml). Fill in what you want to know, the output format, and any context you have. The data team will scope it from there.

## How to contribute code

1. Check [open issues](../../issues) for work that needs doing
2. Comment on the issue to claim it before starting
3. Fork the repo (or create a branch if you have access)
4. Commit with clear messages (`feat:`, `fix:`, `docs:`, `chore:`)
5. Open a PR linking it to the issue with `Closes #N`
6. Wait for review; address any feedback

### PR standards

- One issue per PR
- Include a clear description of what changed and why
- Code review is required before merging to `master`

## Tech stack

| Area | Technology |
|---|---|
| On-chain data pipeline | dbt + HyperSync (Envio) |
| Data warehouse | BigQuery |
| Analytics / dashboards | Dune Analytics (SQL), Looker Studio |
| Scheduled scripts | Google Apps Script |
| Product analytics | Amplitude, Google Analytics |

## Questions

Open an [issue](../../issues) or reach out to the data team on the `#data` Slack channel.

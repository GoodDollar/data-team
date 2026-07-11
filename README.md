# GoodDollar / data-team

The central hub for GoodDollar's analytics and data work. This repo contains the active codebases, SQL queries, documentation, and data dictionary maintained by the data team.

**Data Team Lead:** [@thalescb](https://github.com/thalescb) | **Questions / requests:** [open an issue](../../issues/new/choose)

---

## Repo structure

```
data-team/
├── projects/
│   ├── onchain-analytics/    # On-chain analytics system (dbt + HyperSync pipeline, BigQuery)
│   ├── dashboard-scripts/    # GoodDollar main dashboard (Google Apps Script)
│   ├── weekly-report/        # Weekly data report automation
│   └── automations/          # n8n automation flows (archived)
├── queries/
│   └── dune/                 # Dune Analytics SQL queries
├── tools/
│   └── utm-builder/          # UTM link builder — live at gooddollar.github.io/data-team/utm-builder/
└── docs/
    ├── data-dictionary/      # Data dictionary and definitions
    ├── datasources/          # Data source documentation
    ├── subgraph/             # GoodDollar subgraph schemas
    └── dashboards.md         # Links to live dashboards
```

---

## Active projects

| Project | Description | Status |
|---|---|---|
| [onchain-analytics](projects/onchain-analytics/) | 3-layer BigQuery warehouse (Staging → Semantic → Marts) fed by HyperSync, with dbt transformations. Powers all on-chain dashboards and reporting. | Active |
| [dashboard-scripts](projects/dashboard-scripts/) | Google Apps Script powering the GoodDollar main dashboard | Active (v6) |
| [weekly-report](projects/weekly-report/) | Weekly data report automation | Active |

---

## Documentation

- **[dbt Docs Site](https://gooddollar.github.io/data-team/onchain-analytics/)** — browsable data catalog with model lineage, column descriptions, and business glossary (auto-published from `projects/onchain-analytics/gd_dbt/`)
- **[UTM Builder](https://gooddollar.github.io/data-team/utm-builder/)** — browser-based tool for generating tracked campaign URLs. See the [UTM naming standard](tools/utm-builder/UTM_STANDARD.md) for the full convention.
- **[docs/](docs/)** — data dictionary, data source documentation, subgraph schemas

---

## Submit a data request

Need data analysis, a query, a dashboard, or any other data deliverable?

→ **[Open a Data Request issue](../../issues/new?template=data-request.yml)**

Fill out the template. The more detail you provide, the faster and more accurately it can be delivered.

---

## Contribute / Bounties

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and how the bounty program works.

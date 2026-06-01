# GoodDollar / data-team

The central hub for GoodDollar's analytics and data work. This repo contains the active codebases, SQL queries, documentation, and data dictionary maintained by the data team.

**Data Team Lead:** [@thalescb](https://github.com/thalescb) | **Questions / requests:** [open an issue](../../issues/new/choose)

---

## Repo structure

```
data-team/
├── projects/
│   ├── gd-events-pipeline/   # On-chain event pipeline (TypeScript, BigQuery)
│   │   └── docs/
│   │       └── layer2-entities/  # L2 invite entity reference
│   ├── dashboard-scripts/    # GoodDollar main dashboard (Google Apps Script)
│   └── automations/          # n8n automation flows (archived)
├── queries/
│   └── dune/                 # Dune Analytics SQL queries
└── docs/
    ├── subgraph/             # GoodDollar subgraph schemas
    └── dashboards.md         # Links to live dashboards
```

---

## Active projects

| Project | Description | Status |
|---|---|---|
| [gd-events-pipeline](projects/gd-events-pipeline/) | Indexes on-chain GoodDollar events into BigQuery via HyperSync | Active |
| [dashboard-scripts](projects/dashboard-scripts/) | Google Apps Script powering the GoodDollar main dashboard | Active (v6) |

---

## Submit a data request

Need data analysis, a query, a dashboard, or any other data deliverable?

→ **[Open a Data Request issue](../../issues/new?template=data-request.yml)**

Fill out the template. The more detail you provide, the faster and more accurately it can be delivered.

---

## Contribute / Bounties

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and how the bounty program works.

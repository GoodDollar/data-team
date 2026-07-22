# GoodBuilders Season 4 -- Metrics & Reporting

Standardized metrics infrastructure for GoodBuilders Season 4 builder projects on Celo.

## What This Contains

- **Data dictionary** -- canonical metric names, definitions, calculation methods, and known limitations
- **Dune query templates** -- parameterized SQL that projects fork with their own contract addresses
- **Protocol baseline** -- ecosystem-wide reference metrics for share calculations

## How It Works

Each builder project:
1. Registers their contract addresses in the project registry
2. Forks the Dune query templates and substitutes their own addresses
3. Assembles their own Dune dashboard from the forked query visualizations

The data team owns the metric standard and query logic; projects own their dashboards and reporting.

## Related Repositories

| Repo | What | Owner |
|---|---|---|
| [GoodDollar/builders-metrics](https://github.com/GoodDollar/builders-metrics) | S3 leaderboard pipeline (Cloudflare Worker + Dune/HyperSync connectors) | Lewis |
| This folder | S4 data-team side: definitions, templates, and analysis | Thales |

Season 3 pipeline code and historical run data live in `builders-metrics`.
Season 4 adopts the definitions and templates approach from this folder forward.

## Status

In progress. Metrics alignment with program lead underway.

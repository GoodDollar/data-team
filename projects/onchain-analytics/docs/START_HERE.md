# Start here: GoodDollar onchain analytics

This guide is for engineers who are new to this system. It covers what the system does, what is
running today, how data moves through it, and what has to happen next. Read it before the
detailed references. It also tells you which of those references are current.

Status in this guide is as of **2026-10-05**, code at `master` commit `c34c4c1`.

Statements below fall into three kinds, labelled where it matters:

- **Measured**: observed directly in production metadata or in a run, with the date.
- **Design**: what the merged code does. Tested by automated tests and in disposable sandbox
  datasets, not yet in production.
- **Planned / unverified**: intended next steps, or things nobody has checked yet.

---

## 1. What the system is for

GoodDollar runs smart contracts on several blockchains. Those contracts emit events, for example
"a user claimed UBI", "an invitee joined", or "a bounty was paid". This system copies those
events into Google BigQuery, turns them into business definitions (what counts as a claim, what
counts as a referral signup), and serves them to dashboards. The goal is to answer questions about
onchain GoodDollar activity with SQL against tested, documented tables, without one-off scripts.

---

## 2. What is live, what is prepared, what is not applied

| Item | State | Notes |
| - | - | - |
| dbt models and Looker Studio dashboards for XDC invites and claims | **Live (existing)** | They read the older per-contract tables `ClaimContractEvents` and `InviteContractEvents`. An earlier pipeline version loaded those tables. The current pipeline does not write them and nothing refreshes them on a schedule, so check their latest `block_timestamp` before relying on recency. Their live status comes from earlier project documentation and was not re-checked for this guide. |
| Ingestion pipeline, [`pipeline-v5/`](../pipeline-v5/) | **Merged, not run in production** | Writes the new raw tables. It has run only over small block ranges against sandbox datasets. |
| Five additive schema migrations, [`warehouse/L1/`](../warehouse/L1/) files `08` to `12` | **Merged and rehearsed in a sandbox. Not applied to production.** | Scope and retention are approved. Applying them is blocked on access; see sections 7 and 8. |
| Staging dataset `BlockchainEvents_Staging` | **Not created** | Must exist before any production ingestion. |
| Pipeline writer identity and its permissions | **Not provisioned** | |
| Production ingestion (canary or history) | **Not run, not authorized** | |
| dbt models over the new raw tables, and dashboard cutover | **Not built, not done** | Current models still read the older tables. |
| Scheduled ingestion | **Off** | The GitHub workflow is manual-only and refuses production dataset names. Its authentication does not match the keyless identity design; reconcile it before use. |

The new raw schema has not been commissioned or populated in production. The existing XDC models
and dashboards still use the older per-contract tables; check their freshness before relying on
current data.

---

## 3. How data flows, and who owns each step

```
 Blockchains (Celo, XDC, Ethereum)
      |
      |  pipeline-v5  (TypeScript; reads via HyperSync or JSON-RPC)
      v
 BigQuery raw layer: gooddollar.BlockchainEvents
      RawLogs, Transactions                 undecoded chain data
      IngestionCoverage, PipelineRuns,      bookkeeping: what was read, by which run,
      OracleReconciliation                  and how it compared with the contracts
      |
      |  dbt  (gd_dbt/, SQL models)
      v
 Staging  ->  Semantic  ->  Marts           cleaning, business definitions, dashboard tables
      |
      v
 Looker Studio dashboards
```

| Step | Owned by | Lives in | What it writes |
| - | - | - | - |
| Read the chain | Pipeline | `pipeline-v5/src/` | Nothing by itself |
| Raw capture | Pipeline | `pipeline-v5/src/`; the contract list is the seed `gd_dbt/seeds/contract_deployments.csv` | Raw and bookkeeping tables in `BlockchainEvents` |
| Raw table definitions | Migration files, applied by an administrator | `warehouse/L1/`, `scripts/deploy-warehouse.ps1` | Table and view definitions only, never rows |
| Decode, clean, define business terms | dbt | `gd_dbt/models/` | `Staging`, `Semantic`, `Marts` (or `dev_sandbox` by default) |
| Dashboards | Looker Studio | Outside this repository | Nothing |

Ground rules:

- Only the pipeline talks to the chain.
- The pipeline stores nothing decoded. Turning logs into business events is dbt's job.
- dbt reads raw tables and never writes them.
- Each layer reads only from the layer below it.

A naming note: the raw layer is called **L0** in pipeline code and **L1** in older documents and in
the `warehouse/L1/` folder name. Both mean the `BlockchainEvents` dataset.

---

## 4. The raw layer design

### `RawLogs`: one row per log, every contract, undecoded

Every log a captured contract emits becomes one row. A row stores the chain, block, and
transaction it came from, the emitting contract address, all four topic slots, and the data
section **verbatim**. The pipeline does not try to match the log to an expected event.

- Merge key: `(chain_id, tx_hash, log_index)`. One log, one row.
- Partitioned by month of `block_timestamp`, with **partition filter required**. Every query
  against the table must filter on `block_timestamp`. For whole-history reads, use the
  `RawLogsAllHistory` view, which carries a wide filter in its definition.
- Column definitions: [`warehouse/L1/09_CreateRawLogs_v1.sql`](../warehouse/L1/09_CreateRawLogs_v1.sql).

### `Transactions`: one row per transaction that produced a captured log

- Merge key: `(chain_id, tx_hash)`.
- A reverted transaction emits no logs, so it never appears here. Absence from this table means
  "produced no captured log", not "did not happen".
- `TransactionsAllHistory` is its whole-history view.

### Provenance on every row

Every raw row records where it came from: `source_kind` and `source_id` (which reader answered),
`assurance` (how independently confirmed the read was; see section 5), `capture_id` and
`ingestion_run_id` (which capture and run wrote it), `ingested_at`, and the contract era fields
(`implementation_address`, `era_index`, `era_resolution`). If the era cannot be resolved, the row
says `unresolved` and does not guess.

### The bookkeeping tables

| Table | Answers |
| - | - |
| `IngestionCoverage` | Which reader read which block range of which contract, what it found, what failed, and how far the result can be trusted. The pipeline writes one row for every attempted range, including failures and refusals. **The next run resumes from this table**, not from the highest block number in the data. A block range with no coverage row was never read. |
| `PipelineRuns` | One row per command, with its exit code and outcome counts |
| `OracleReconciliation` | Per protocol day: what the contract's own ledger says against what the warehouse holds |

### Why raw data stays undecoded

- A decoding mistake is fixed by changing a dbt model and rebuilding. Nobody has to re-read the
  chain.
- A new event on an existing contract needs no schema change.
- No log is lost because nobody had defined a column for it.

The cost: a raw row means nothing on its own until a model matches it against the event
reference seed, [`gd_dbt/seeds/event_surface.csv`](../gd_dbt/seeds/event_surface.csv).

### Why raw data is preserved rather than replaced

- The pipeline never drops or truncates raw tables. Its writer identity is designed to have no
  permission to delete tables in the raw dataset.
- Reading the same log twice updates its single row instead of adding a second one. A matched
  row is rewritten whole, so its block facts stay correct after a chain reorganisation.
- `dedup` is the only mode that removes rows, and it removes only repeated keys.
- Schema migrations are additive: create-if-absent, or add nullable columns. Existing rows remain,
  and older rows read `NULL` in the new columns.
- Retention (approved): no automatic expiration on raw or bookkeeping tables. Only temporary
  tables in `BlockchainEvents_Staging` expire, after six hours, once that dataset exists.

---

## 5. Readers: how the pipeline reads each chain

- **HyperSync** is Envio's indexed blockchain data service. It is fast and needs an
  `ENVIO_API_TOKEN`. It is the primary reader wherever an index exists for the chain.
- **JSON-RPC** is the standard API that blockchain nodes expose. The pipeline uses it to read
  chains that have no HyperSync index, to check empty ranges, and to read contract state for
  `verify`.

### Release scope (Design, enforced in code)

The chain list is frozen in `RELEASE_SCOPE_FREEZE`, in
`pipeline-v5/src/control-plane/releaseScope.ts`. The decision is explained in
[`release-scope.md`](release-scope.md).

| Chain | Chain id | Status | Reader in code |
| - | - | - | - |
| Celo | 42220 | In release | HyperSync; RPC for empty-range checks |
| XDC | 50 | In release | HyperSync; RPC for empty-range checks |
| Ethereum | 1 | Declared in release scope; no ingestion planned for this release | JSON-RPC only, because no HyperSync index resolves for it |
| Fuse | 122 | Dropped 2026-09-28 | The pipeline refuses it |
| Base, Gnosis | n/a | Not assessed (no queries were made against either chain) | None |

Fuse remains in the network configuration, and the default chain selection includes it. A run
without `--chains` therefore reports Fuse as unsupported and cannot exit 0. Always pass `--chains`.

### Empty results are not proof of absence

A reader that returns no logs for a range has not proved that nothing happened there. Public
endpoints can return an empty answer without raising an error. **Measured:** an identical repeated
log query returned zero 7 times in 10 on one day and 3 times in 10 on the day before. One Celo
endpoint returned false zeros 20 to 90 percent of the time, depending on how old the range was.

What the pipeline does (Design):

1. If HyperSync reports that it stopped early in a chunk, the chunk counts as a failure and is
   retried. It is never treated as empty.
2. If a chunk has no logs for a contract, the pipeline asks **every configured RPC endpoint** for
   that contract and range. The range is split to each chain's per-request limit: 1,000 blocks on
   XDC and 5,000 on Celo.
3. Then one of three things happens:
   - **An endpoint finds a log.** The empty result is refuted. The capture is not recorded as
     complete, and a later run reads the range again. The logs RPC found are not written by this
     check.
   - **At least two endpoints cover the whole range without error and find nothing.** The
     emptiness is *corroborated* and coverage may advance past it. This is still not proof.
   - **Fewer than two endpoints do so.** The range is recorded `unconfirmed_empty` and coverage
     does not advance.

Limitations of the RPC check:

- It can refute an empty result, but it cannot prove one.
- It is expensive on sparse ranges. Calls per empty chunk = sub-ranges x endpoints. With
  defaults, an empty 20,000-block XDC chunk costs up to 60 calls, and Celo costs up to 12.
- On Ethereum, the check queries the same endpoints that did the read. It repeats the read; it
  does not add an independent source.
- Setting `CONFIRM_EMPTY_CHUNKS=false` turns the check off. Leave it on.
- Reading over RPC (Ethereum) costs one extra call per block and two per transaction to fetch
  block and transaction details. Public endpoint rate limits make wide ranges slow.

### Assurance grades

Each capture is graded by how many independent sources agree on it:

- **A**: two independent sources each enumerated the range and returned identical results.
- **B**: one source enumerated the range, and a second confirmed its emptiness.
- **C**: one source only.

A complete HyperSync capture is normally **C**, because one index is one source. An Ethereum RPC
capture where two endpoints agree can be **A**. The grade measures independent confirmation, not
reader quality.

---

## 6. Safety and correctness controls

All of these are **Design**: they exist in merged code and are exercised by the automated test
suite and by small sandbox runs.

| Control | What it does |
| - | - |
| Bounded chunks | Ranges are read in fixed block chunks: 20,000 blocks by default on Celo and XDC, 50,000 on Ethereum. A chunk either completes or is recorded as skipped. |
| Block-boundary writes | Buffers are flushed only between blocks, so a write never contains part of a block. |
| Stage plus MERGE | Rows load into a temporary table in `BlockchainEvents_Staging`, then merge into the target on its key. Re-running a range leaves one row per key. Each MERGE is limited to a literal time window derived from the rows, padded one month on each side. |
| One writer at a time | A file lease blocks a second process on the same host from writing to the same table. A waiting writer gives up after 15 minutes, exits nonzero, and records the range as incomplete. A dead same-host process is detected and its lease reclaimed immediately; otherwise any lease older than the one-hour stale timeout can be reclaimed by age. **Limit:** this is not a cross-machine lock, and the full production workload has not tested the one-hour timeout boundary. |
| Explicit coverage | Resume points come from `IngestionCoverage`. Gaps, refusals, and unreadable ranges are recorded, never inferred from the data. |
| Retries and deadlines | Each HyperSync chunk runs in a child process that is killed after 120 seconds. One contract's whole range is abandoned after 90 minutes, and the blocks not attempted are recorded. Every RPC call has a 30-second deadline. BigQuery and HyperSync calls retry up to 5 times with backoff, and requests are paced. |
| Finality | Ingestion stays behind the chain tip: 15 blocks on XDC, 1,930 blocks (about 32 minutes) on Celo, 94 blocks on Ethereum. A range the reader still holds as reversible is recorded `rollback_eligible` and read again later. |
| Cost and size budgets | Every BigQuery job carries a 10 GiB `maximumBytesBilled` cap. A run may attempt at most 12 contracts. One capture may span 30 days of blocks unless the range is named with `--from` and `--to`, and named ranges are capped at 100,000,000 blocks. A bare `backfill` and a one-sided range are both refused. |
| Release scope | Dropped or undeclared chains are refused on every path that reads or writes. |
| Startup schema check | Every mode except `plan` checks the bookkeeping tables' columns first and stops with `SCHEMA_MISMATCH` if the live tables are behind the code. |
| Exit statuses | `0`: at least one unit completed and none was refused, unsupported, incomplete, or failed. `1`: partial, or a read-only check found something. `2`: nothing completed, the scope was empty, the run was refused, or the arguments were wrong. `PipelineRuns` records the same outcome. Any nonzero exit alerts Slack if a webhook is configured. |
| Data verification | `verify` reconciles warehouse counts and amounts, per protocol day, against the contracts' own ledgers. Ledgers exist only for the UBIScheme on Celo and XDC and the Invites contract on XDC. `coverage` lists unread ranges and logs that no event definition matches. `calibrate` measures each source's miss rate. dbt has uniqueness tests on both raw merge keys; they are disabled until the tables exist and are enabled with `--vars '{l0_v4_tables_exist: true}'`. |

**What this testing does and does not show.** These controls passed the credential-free test
suite, small-range runs against sandbox datasets, and a labelled-sandbox rehearsal of the five
migrations. That rehearsal ran each migration twice, with no change on the second run, and kept
all historical fixture rows. None of this proves a full-history or 12-month production run, the
production permission setup, or production cost and throughput at scale. Those are only shown by
running in production, starting with a canary.

---

## 7. Three separate operations, three separate approvals

| | Schema commissioning | Data ingestion | dbt transformation |
| - | - | - | - |
| What it does | Creates or alters raw table and view definitions | Reads chains and writes raw rows and bookkeeping | Builds `Staging`, `Semantic`, and `Marts` from raw tables |
| Tool | `scripts/deploy-warehouse.ps1` with one named migration from `warehouse/L1/` | `pipeline-v5` | `gd_dbt` |
| Identity | A temporary schema-commissioner service account, impersonated by an administrator | A separate pipeline writer identity | The credentials in your dbt profile |
| Writes rows? | No | Yes (raw dataset) | Yes (derived datasets only) |
| State on 2026-10-05 | Approved, not applied | Not run, not authorized | Existing models run over the older tables |

Approving one of these does not authorize the next.

### Production access roles

- **Personal login (Application Default Credentials).** This is read access, not a production
  writer. Use it for local development and read-only checks, not as the production writer. Verify
  effective permissions in the target environment; production commissioning and ingestion use
  separately provisioned identities.
- **Schema commissioner (proposed, not provisioned).** A dedicated service account with no
  downloadable key. On the project it may only run jobs. On `BlockchainEvents` it may create,
  list, get, and read tables and update table definitions (required by `ALTER TABLE`). It cannot
  write rows, delete anything, or change access. It is granted for a single window of at most 30
  minutes, then revoked, and the revocation is verified.
- **Pipeline writer (proposed, separate).** On the raw dataset it may create tables, read, and
  write rows, but not delete tables or the dataset. On `BlockchainEvents_Staging` it may also
  delete tables. That is why staging has its own dataset.
- **Administrator.** Someone who can create service accounts, add and remove role bindings, grant
  temporary impersonation (Service Account Token Creator), and create the staging dataset. The
  administrator who grants access also removes it. Owning the `BlockchainEvents` dataset lets an
  owner change that dataset's access list. It does not by itself include the project-level
  permissions to create service accounts or grant impersonation, so confirm those separately.

No service-account keys are used. The migration helper passes the impersonated identity only to
the `bq` process it starts, and never changes persistent `gcloud` settings.

---

## 8. The safe next step (as of 2026-10-05)

1. **Commission the approved schema through a temporary, narrow identity.** An administrator
   provisions the schema commissioner and grants themselves temporary impersonation on it. They
   then apply the five migrations one at a time, in this order: `09_CreateRawLogs_v1.sql`,
   `08_PipelineRunsOutcome_v1.sql`, `10_AddOracleReconciliationCompatibility_v1.sql`,
   `11_CreateRawLogsAllHistory_v1.sql`, `12_CreateTransactionsAllHistory_v1.sql`. Finally, they
   remove the grants. The exact command and stop conditions are in
   [`03_OPERATIONS.md`](03_OPERATIONS.md#l1-raw-tables----allowlisted-additive-migrations).
2. **Verify, live.** Check each of the following:
   - **Schemas.** `RawLogs` has 25 columns, monthly partitioning, and a required partition filter.
     `PipelineRuns` has 41 columns. `OracleReconciliation` has nullable `chain_id` and
     `contract_address` and keeps `table_id`. Both all-history views exist.
   - **Records.** Row counts are unchanged: `PipelineRuns` 22, `OracleReconciliation` 265,
     `IngestionCoverage` 10, `Transactions` 0. No expiration is set on permanent tables.
   - **Permissions.** A fresh effective-permission check shows the commissioner's mutation
     permissions denied after revocation.
3. **Only then, authorize a bounded canary.** A canary is a deliberately small first production
   ingestion. Before it runs:
   - Create `BlockchainEvents_Staging` with a six-hour default table expiration.
   - Provision the pipeline writer identity.
   - Run `plan` for an explicit range.

   Then run `backfill` with `--chains`, `--addresses`, `--from`, and `--to`, followed by
   `coverage` and `verify`. Finally, check the resulting `PipelineRuns` and `IngestionCoverage`
   rows. The canary's contracts and block range have not been chosen yet.

**What schema approval does not authorize:** the full 12-month Celo and XDC ingestion, scheduling,
or moving dbt models and dashboards onto the new tables. Each one is a separate decision, made
after the canary result is reviewed.

---

## 9. What you can safely run today

None of these commands writes to a production dataset.

```bash
cd pipeline-v5
npm install
npm test                         # credential-free automated test suite
cp .env.example .env             # every mode needs ENVIO_API_TOKEN set, even plan
npx tsx src/index.ts plan --chains=XDC --addresses=<contract> --from=<start-block> --to=<end-block>
```

`plan` reads no chain and writes nothing to BigQuery. It lists the exact work and checks it
against the budgets.

```powershell
# from projects/onchain-analytics/
.\scripts\deploy-warehouse.ps1 -Migration 09_CreateRawLogs_v1.sql    # prints the target only
```

```bash
cd gd_dbt
dbt run      # default "dev" target writes to the dev_sandbox dataset, not production
dbt test
```

dbt setup is in [`03_OPERATIONS.md`](03_OPERATIONS.md#staging-semantic-marts--dbt).

**Do not run against production** until the steps in section 8 are complete: `daily`,
`backfill`, `repair`, `dedup`, `verify`, `coverage`, or `calibrate`. Each of these starts with the
bookkeeping-table check and records a `PipelineRuns` row, so each needs the migrated schema and a
writer identity.

---

## 10. Finding your way around

| Path | What is there |
| - | - |
| [`pipeline-v5/`](../pipeline-v5/) | The ingestion pipeline. Entry point `src/index.ts`. Readers: `src/reader.ts`, `src/hypersync.ts`, `src/rpc.ts`. Orchestration: `src/pipeline.ts`. Resume and gaps: `src/coverage.ts`, `src/repair.ts`. Exit codes: `src/outcome.ts`. Chains and settings: `src/config.ts`. |
| [`warehouse/L1/`](../warehouse/L1/) | Raw table DDL. Files `08` to `12` are the allowlisted migrations. `06_L0Contract_v4.sql` is a design reference; **do not run it**. |
| [`scripts/`](../scripts/) | `deploy-warehouse.ps1`, the migration helper. `ops/validate-l0-migrations.mjs`, the sandbox rehearsal. |
| [`gd_dbt/`](../gd_dbt/) | dbt project: models, tests, and the reference seeds (contracts, events, chains, tokens). |
| [`contracts/`](../contracts/) | ABIs and contract reference material |
| [`docs/`](.) | This guide and the references below |

### Which documents are current

| Document | Status |
| - | - |
| This guide | Current as of 2026-10-05 |
| [`pipeline-v5/README.md`](../pipeline-v5/README.md) | Current. Detailed reference for modes, bookkeeping tables, and failure handling |
| [`03_OPERATIONS.md`](03_OPERATIONS.md) | Current for setup, migrations, and dbt. Pipeline commands corrected to match the code |
| [`release-scope.md`](release-scope.md) | Current |
| [`02_DATA_MODEL.md`](02_DATA_MODEL.md) | Describes the older per-contract tables and the `Semantic` and `Marts` models that dashboards use today. Does not describe `RawLogs` or `Transactions`. |
| [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md) | **Partly outdated.** Its raw-layer section describes the older per-contract design. Its "how to add a contract" steps use options that no longer exist; do not follow them. |
| [`00_VISION.md`](00_VISION.md) | Historical MVP-era motivation; not current architecture or status. |
| `04_CONTRACT_MECHANICS.md`, `05_ANALYTICS_DOCUMENTATION_CONTRACT.md`, `06_BUSINESS_GLOSSARY_AND_AI_DISAMBIGUATION.md` | Contract behaviour, model documentation rules, and business terms. Not tied to the raw-layer design. |
| [dbt docs site](https://gooddollar.github.io/data-team/) | Model and column lineage for the dbt project |

If an older document contradicts this guide or the code, the code is the authority. Do not run a
pipeline command from an older document unless it matches the usage text at the top of
`pipeline-v5/src/index.ts` or the pipeline README.

---

## 11. Vocabulary

| Term | Meaning |
| - | - |
| Block | A batch of transactions the chain adds at one time. Has a number, a hash, and a timestamp. |
| Block range | An inclusive span of block numbers, for example `--from=100 --to=199`. The unit of reading and of coverage. |
| Chain tip | The newest block a chain has produced. |
| Finality | The point after which a block will not be replaced. The pipeline stays a fixed number of blocks behind the tip. |
| Reorganisation (reorg) | The chain replacing recent blocks with different ones. A log can move to another block. |
| Log / event | A record a contract emits during a transaction, such as `UBIClaimed`. "Event" is the contract's definition; "log" is one occurrence of it. |
| Topic, `topic0` | Indexed fields of a log. `topic0` is normally the event's signature hash and identifies which event it is. |
| `log_data` | The non-indexed part of a log, stored as hex. |
| Era | A period during which a proxy contract pointed to one implementation. Upgrades start a new era. |
| HyperSync | Envio's indexed service for reading chain data quickly. Primary reader where an index exists. |
| RPC (JSON-RPC) | The standard request API of a blockchain node. `eth_getLogs` is its log query. |
| False zero | An empty answer from an endpoint for a range that actually contains logs, returned without an error. |
| Raw layer | The `BlockchainEvents` dataset: undecoded chain data plus bookkeeping. Called L0 in code, L1 in older docs. |
| Merge key | The columns that identify one row, used by `MERGE` to update rather than duplicate. |
| MERGE | A BigQuery statement that inserts new keys and updates existing ones in one step. |
| Staging dataset | `BlockchainEvents_Staging`: temporary tables used for each write, separate from production so the writer never needs delete rights there. Unrelated to dbt's `Staging` layer. |
| Partition filter | A required `WHERE` condition on `block_timestamp` that stops a query from scanning the whole table. |
| Capture | One reader reading one or more contracts over one block range in one run. |
| Coverage, coverage record | `IngestionCoverage`: which ranges were read, how, and with what result. A range with no row was never read. |
| Coverage frontier | The edge of the last clean capture. `daily` resumes from here. |
| Assurance | The A/B/C grade for how independently a capture was confirmed. |
| Oracle | A contract's own public per-day ledger, used by `verify` as an external check. |
| Protocol day | The contract's own day boundary. For the UBIScheme it starts at 12:00 UTC, not midnight. |
| dbt | The SQL transformation tool that builds `Staging`, `Semantic`, and `Marts` from raw tables. |
| Staging / Semantic / Marts | dbt layers: light cleaning; business definitions; dashboard-shaped tables. |
| ADC | Application Default Credentials: the personal Google login that local tools use. |
| Service account | A non-human Google identity with its own permissions. |
| Impersonation | Acting as a service account through short-lived tokens, without a key file. |
| Migration | One additive DDL file that changes a raw table or view definition. |
| Commissioning | Applying approved migrations to production. Changes definitions, writes no rows. |
| Canary | A deliberately small first production ingestion, used to prove the write path and permissions before anything larger. |
| Release scope | The frozen list of chains this release may read: Celo, XDC, Ethereum. |

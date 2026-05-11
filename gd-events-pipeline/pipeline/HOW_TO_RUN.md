# How to Run the Pipeline — Beginner's Guide

This guide walks you through everything from scratch: setting up the BQ table,
running your first backfill, scheduling daily updates, and making changes to
what gets ingested.

---

## What does this pipeline do?

It reads blockchain event logs from on-chain smart contracts (using a service
called HyperSync) and writes them as rows into a BigQuery table. Each row is
one blockchain event — for example, one `UBIClaimed` event fired when a user
claimed their UBI.

---

## Prerequisites (things you need installed once)

- **Node.js** — download from https://nodejs.org (LTS version)
- **Google Cloud CLI** — download from https://cloud.google.com/sdk/docs/install
- A GCP account with access to the `gooddollar` BigQuery project
- Your `ENVIO_API_TOKEN` (Envio HyperSync API key)

---

## Phase 0 — One-time local setup

### 0.1 Install dependencies

Open a terminal, navigate to this folder, and run:

```
npm install
```

This downloads all the libraries the pipeline needs. You only need to do this
once (or again after someone changes `package.json`).

### 0.2 Create your .env file

Copy the example env file:

```
cp .env.example .env
```

Then open `.env` in a text editor and fill in your `ENVIO_API_TOKEN`:

```
ENVIO_API_TOKEN=your-token-here
```

### 0.3 Log in to Google Cloud

Run this once per machine. It opens a browser window where you authenticate
with your Google account:

```
gcloud auth application-default login
```

After logging in, the terminal will confirm that credentials were saved.
The pipeline uses these credentials automatically — you don't need to pass
passwords anywhere.

---

## Phase 1 — Set up the BigQuery table

You need to do this **before** running the pipeline for the first time, or
any time you change the table schema (add columns, etc.).

### 1.1 Open the BigQuery console

Go to: https://console.cloud.google.com/bigquery

Make sure the project selector at the top says `gooddollar`.

### 1.2 Drop the old table (if it exists)

> Skip this step if you are setting up for the very first time.

If there is already a `ClaimContractEvents` table with an old schema, you
need to delete it first. In the BigQuery console:

1. In the left panel, expand **gooddollar → BlockchainEvents**
2. Click on `ClaimContractEvents`
3. Click the **Delete table** button (trash icon) in the top right
4. Type the table name to confirm, click **Delete**

**Warning:** This permanently deletes all existing data. You will re-ingest
it in Phase 2.

### 1.3 Create the new table

In the BigQuery console, click the **+ Compose new query** button (top left).
Paste the SQL below into the editor and click **Run**:

```sql
CREATE TABLE `gooddollar.BlockchainEvents.ClaimContractEvents` (
  network                  STRING     OPTIONS(description="Chain name: FUSE, CELO, XDC"),
  chain_id                 INT64      OPTIONS(description="EVM chain ID: 122, 42220, 50"),
  block_number             INT64,
  block_hash               STRING,
  block_timestamp          TIMESTAMP,
  tx_hash                  STRING,
  tx_index                 INT64,
  tx_from                  STRING     OPTIONS(description="Transaction sender"),
  tx_to                    STRING     OPTIONS(description="Transaction recipient"),
  tx_value                 STRING     OPTIONS(description="Native token value in wei"),
  tx_gas                   STRING     OPTIONS(description="Gas limit"),
  tx_gas_price             STRING     OPTIONS(description="Gas price in wei"),
  tx_effective_gas_price   STRING     OPTIONS(description="Post-EIP1559 effective gas price"),
  tx_gas_used              STRING     OPTIONS(description="Gas consumed"),
  tx_status                INT64      OPTIONS(description="1=success, 0=reverted"),
  tx_nonce                 INT64,
  log_index                INT64      OPTIONS(description="Log position within block"),
  contract_address         STRING,
  event_name               STRING,
  ingested_at              TIMESTAMP  OPTIONS(description="When this batch was written"),
  claimer                  STRING     OPTIONS(description="Address that claimed UBI"),
  amount                   STRING     OPTIONS(description="Amount claimed in wei")
);
```

You should see a green checkmark and "This statement created a new table."

---

## Phase 2 — Run the first backfill

A backfill reads the entire blockchain history from the contract deployment
block up to today and inserts everything into BQ.

In your terminal (in this folder), run:

```
npx tsx index.ts backfill claim
```

You will see output like:

```
Mode: backfill | Contracts: claim
Project: gooddollar | Dataset: BlockchainEvents

=== CLAIM → BlockchainEvents.ClaimContractEvents ===

--- BACKFILL: FUSE (chainId 122) from block 15747401 ---
[FUSE] Fetching from block 15747401 to latest...
[FUSE] First event: UBIClaimed at block 15748012
[FUSE] Inserted 500 rows (total: 500)
...
[FUSE] Done. Decoded: 12483, skipped: 0.
```

This will take **several minutes to an hour** depending on how much history
there is. Let it finish. Do not close the terminal.

> **If it fails mid-way:** Just run the same command again. The pipeline
> resumes from the last ingested block — it won't re-insert duplicate rows
> because BigQuery deduplicates by `(network, tx_hash, log_index)`.

---

## Phase 3 — Run a daily append (catch up / stay up to date)

After the backfill, you only need to fetch new events since the last run:

```
npx tsx index.ts append claim
```

Or to update all registered contracts at once:

```
npx tsx index.ts append
```

Run this once a day (or set up the cron job below).

---

## Phase 4 — Schedule daily runs (Linux/Mac server)

Add this line to your crontab (`crontab -e`) to run every day at 00:30 UTC:

```cron
30 0 * * * cd /path/to/gd-events-pipeline && /usr/local/bin/npx tsx index.ts append >> /var/log/pipeline.log 2>&1
```

Replace `/path/to/gd-events-pipeline` with the actual folder path.
Replace `/usr/local/bin/npx` with the output of `which npx`.

> On Windows, use Task Scheduler instead. Set the action to run
> `npx tsx index.ts append` in the pipeline folder.

---

## How to query the data

Once data is in BigQuery, open the BQ console and run queries like:

```sql
-- How many UBI claims per day per network?
SELECT
  DATE(block_timestamp) AS claim_date,
  network,
  COUNT(*) AS claims,
  SUM(CAST(amount AS BIGNUMERIC)) / 1e18 AS total_g$
FROM `gooddollar.BlockchainEvents.ClaimContractEvents`
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

```sql
-- Last 20 claims on Celo
SELECT claimer, amount, block_timestamp, tx_hash
FROM `gooddollar.BlockchainEvents.ClaimContractEvents`
WHERE network = 'CELO'
ORDER BY block_timestamp DESC
LIMIT 20;
```

---

## How to add or remove events

Events are controlled by the `abi` array inside each contract config in
[index.ts](index.ts). Only events listed there will be decoded and inserted.

### To enable a commented-out event (e.g. `UBICalculated`)

1. Open `index.ts` and find the `abi` array in the `claim` config.
2. Remove the `//` at the start of the `UBICalculated` line.
3. Add the new columns to the BQ table:

```sql
ALTER TABLE `gooddollar.BlockchainEvents.ClaimContractEvents`
  ADD COLUMN day STRING,
  ADD COLUMN daily_ubi STRING,
  ADD COLUMN ubi_block_number INT64;
```

4. Add a `case "UBICalculated":` block in `decodeToRow` to populate those columns.
5. Run `npx tsx index.ts backfill claim` to back-fill the new event into history.

### To disable an event

Comment it out in the `abi` array by putting `//` at the start of its line.
The pipeline will silently skip it going forward. Existing rows in BQ are
not deleted.

---

## How to add a new contract

1. **Open `index.ts`** and add a new entry to `CONTRACT_CONFIGS`:

```typescript
mycontract: {
  tableId: "MyContractEvents",
  contracts: ["0xYourContractAddress"],
  networks: [
    { url: "https://celo.hypersync.xyz", name: "CELO", chainId: 42220, firstBlock: 18_000_000, finalityBlocks: 64 },
  ],
  abi: [
    { anonymous: false, inputs: [...], name: "MyEvent", type: "event" },
  ] as const,
  decodeToRow: (_eventName, args, log, tx, networkName, chainId, ingestedAt) => ({
    // common columns (copy from the claim config above)
    network: networkName,
    chain_id: chainId,
    // ...
    // event-specific columns
    my_field: args.myField ?? null,
  }),
},
```

2. **Create the BQ table** using a `CREATE TABLE` statement (see Phase 1.3 as template).

3. **Run the backfill:**

```
npx tsx index.ts backfill mycontract
```

4. From now on, `npx tsx index.ts append` will automatically include it.

---

## How to find the right `firstBlock`

`firstBlock` is the block number just before the contract was deployed. Setting
it too low wastes time scanning empty blocks; setting it too high misses early
events.

To find the deployment block:
1. Go to the block explorer for the chain (e.g. celoscan.io for Celo)
2. Search the contract address
3. Click **Contract** → **Transactions** and find the contract creation tx
4. Note the block number — use that (or subtract 1 to be safe)

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| `ENVIO_API_TOKEN is missing or empty` | Make sure `.env` exists and has the token |
| `Could not authenticate to Google` | Run `gcloud auth application-default login` again |
| `Table not found` | Run the `CREATE TABLE` DDL in Phase 1.3 first |
| `Insert failed: schema mismatch` | The table schema doesn't match what the pipeline is trying to write — re-create the table using Phase 1.2–1.3 |
| Pipeline exits with 0 rows | The `firstBlock` may be set too high, past all events |
| Duplicate rows in BQ | Run `SELECT COUNT(*), COUNT(DISTINCT CONCAT(network,tx_hash,CAST(log_index AS STRING))) FROM ...` — if they differ, run a dedup query |

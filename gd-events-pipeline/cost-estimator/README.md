# GoodDollar — Event Pipeline Cost Estimator

Standalone script that scans every deployed GoodDollar contract via Envio HyperSync
and outputs a BigQuery cost forecast as a CSV you can import directly into Google Sheets.

Covers: **Celo, XDC, Ethereum** — Fuse is excluded per team decision.

---

## Prerequisites

- Node.js ≥ 18
- An Envio HyperSync API token (same one used by the main pipeline)

---

## Setup (one-time)

```bash
# 1. Enter this folder
cd cost-estimator

# 2. Install dependencies
npm install

# 3. Create your .env file
copy .env.example .env
# Then open .env and paste your ENVIO_API_TOKEN
```

---

## Running the estimator

### Quick mode (recommended first run, ~3–8 min)

Counts only the last 7 days per contract to establish a daily rate, then
**estimates** the historical total as `dailyRate × daysSinceDeployment`.
Fast and sufficient for initial forecasting.

```bash
npx tsx estimate.ts
# or: npm run estimate
```

### Full mode (accurate backfill sizing, 30–90+ min)

Streams **all** historical logs from deployment block to chain tip for each contract.
Required for precise one-time backfill cost. G$ Token on Celo/Ethereum may take
particularly long due to high Transfer event volume.

```bash
npx tsx estimate.ts --full
# or: npm run estimate:full
```

### Additional options

```bash
# Only scan one group of contracts (see group names below)
npx tsx estimate.ts --group "UBIScheme"
npx tsx estimate.ts --full --group "G$ Token"

# Override per-contract timeout in full mode (default 300s)
npx tsx estimate.ts --full --timeout 600
```

---

## Output

A file named `cost-estimate-YYYY-MM-DD.csv` is written to this folder and a
summary is printed to the console.

**To open in Google Sheets:**
File → Import → Upload → select the CSV → Replace current sheet.

---

## Contract groups scanned

| Group | Contracts | Expected volume |
|---|---|---|
| G$ Token | ERC20 / Celo / XDC / Ethereum | HIGH (every Transfer) |
| UBIScheme | Celo, XDC | HIGH (once per user per day) |
| Invite | Celo, XDC | MEDIUM (one-time per user) |
| Identity | Celo, XDC, Ethereum | MEDIUM (per user whitelist) |
| Mento / Reserve & DeFi | Celo, XDC | MEDIUM |
| Bridge | Celo, XDC, Ethereum | MEDIUM |
| DAO | Celo, XDC, Ethereum | LOW |
| Utility | Faucet, NameService, OneTimePayments, ContributionCalculation | LOW–MEDIUM |

---

## How to add a new contract

Open `estimate.ts` and add an entry to the `CONTRACTS` array:

```typescript
{
  group:      "Your Group Name",
  label:      "ContractName / Chain",
  chain:      "CELO",                          // CELO | XDC | ETHEREUM
  address:    "0xYourContractAddress",
  firstBlock: 18_000_000,                      // deployment block; [~] if approximate
  note:       "optional warning shown in CSV", // omit if none
},
```

`blocksPerDay` is derived automatically from the `chain` field.

---

## Reading the cost columns

| Column | What it means |
|---|---|
| **Backfill via Streaming Insert** | Cost if you used the pipeline's `table.insert()` for backfill — **do not do this** |
| **Backfill via Load Job** | Always $0 — BQ batch loads are free; use this for all historical data |
| **Monthly Storage USD** | BQ storage cost for the current data volume ($0.02/GB/month active rate) |
| **1-Year Cumulative Storage** | Projected storage bill over 12 months as data grows (switches to $0.01/GB after 90 days) |
| **Daily L3 Mart Scan GB** | How many GB the 4 L3 daily rebuilds will scan from this contract's L1 table |
| **Monthly Query Cost** | Scan cost before the 1 TB/month free tier; the grand total row applies the deduction |

---

## Known limitations

- **Approximate `firstBlock` values** — contracts marked `[~]` in the source use
  estimated deployment blocks. The scan safely returns 0 events before actual
  deployment, so counts are still correct; only scan speed is affected.
  Update the `firstBlock` values to exact deployment blocks for faster future runs.

- **Mento contract addresses** — the GoodDollar docs list the same address for
  MentoReserve, MentoExpansionController, MentoExchangeProvider, and MentoBroker
  on both Celo and XDC. This appears to be a documentation error. The script counts
  all logs at that address (which may represent a proxy or router). Verify the
  individual contract addresses before building production pipeline ingestion for
  this group.

- **Envio HyperSync cost** — not included in any estimate. Check your current
  plan at [envio.dev](https://envio.dev).

- **L2 views** — because all L2 entities are VIEWs (not TABLEs), their query
  cost is already captured in the L3 mart scan rows above. No separate line item.

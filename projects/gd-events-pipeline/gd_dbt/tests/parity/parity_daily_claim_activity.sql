{{ config(tags=['parity'], severity='warn') }}

/*
  Parity test: daily_claim_activity
  Compares dbt mart vs production gooddollar.Marts.daily_claim_activity
  Only compares dates present in production (production may be stale).
  Returns rows on FAILURE (metric mismatch on overlapping dates).

  NOTE: severity=warn because raw ClaimContractEvents has known ingestion
  duplicates on some dates. The production mart was built before those dupes
  existed. This test will warn until either (a) pipeline dedup is fixed or
  (b) production mart is rebuilt from current data.
*/

WITH prod AS (
  SELECT
    metric_date,
    network,
    daily_claims,
    daily_total_g_claimed
  FROM `gooddollar.Marts.daily_claim_activity`
),

dbt_model AS (
  SELECT
    metric_date,
    network,
    daily_claims,
    daily_total_g_claimed
  FROM {{ ref('daily_claim_activity') }}
)

-- Return rows where production and dbt disagree on overlapping dates
SELECT
  p.metric_date,
  p.network,
  p.daily_claims AS prod_claims,
  d.daily_claims AS dbt_claims,
  p.daily_total_g_claimed AS prod_g,
  d.daily_total_g_claimed AS dbt_g
FROM prod p
JOIN dbt_model d
  ON p.metric_date = d.metric_date
 AND p.network = d.network
WHERE p.daily_claims != d.daily_claims
   OR p.daily_total_g_claimed != d.daily_total_g_claimed

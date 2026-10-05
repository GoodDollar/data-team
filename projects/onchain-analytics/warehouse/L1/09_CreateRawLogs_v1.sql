-- One additive statement. Does not alter or replace an existing table.
-- Identifiers are rendered from literal placeholders by the deployment helper.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.RawLogs`
(
  chain_id                 INT64     NOT NULL,
  block_number             INT64     NOT NULL,
  block_timestamp          TIMESTAMP NOT NULL,
  block_hash               STRING    NOT NULL,
  tx_hash                  STRING    NOT NULL,
  tx_index                 INT64     NOT NULL,
  log_index                INT64     NOT NULL,
  contract_address         STRING    NOT NULL,
  implementation_address   STRING,
  era_index                INT64,
  era_resolution            STRING    NOT NULL,
  topic0                    STRING,
  topic1                    STRING,
  topic2                    STRING,
  topic3                    STRING,
  topic_count               INT64     NOT NULL,
  log_data                  STRING    NOT NULL,
  removed                   BOOL,
  source_kind               STRING    NOT NULL,
  source_id                 STRING    NOT NULL,
  assurance                 STRING    NOT NULL,
  confirmations_at_capture  INT64,
  capture_id                STRING    NOT NULL,
  ingestion_run_id          STRING    NOT NULL,
  ingested_at               TIMESTAMP NOT NULL
)
PARTITION BY TIMESTAMP_TRUNC(block_timestamp, MONTH)
CLUSTER BY chain_id, contract_address, topic0, block_number
OPTIONS(
  require_partition_filter = TRUE,
  description = "L0 raw log store. One row per log, keyed by (chain_id, tx_hash, log_index)."
);
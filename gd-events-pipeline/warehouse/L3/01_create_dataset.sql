-- L3: Marts dataset
-- Run once before deploying any L3 mart.

CREATE SCHEMA IF NOT EXISTS `gooddollar.Marts`
OPTIONS (
  location = 'US',
  description = "L3 — pre-aggregated, dashboard-ready datasets. Rebuilt daily via CREATE OR REPLACE TABLE. See docs/01_ARCHITECTURE.md."
);

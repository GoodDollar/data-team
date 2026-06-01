-- L2: Semantic dataset
-- Run once before deploying any L2 view.

CREATE SCHEMA IF NOT EXISTS `gooddollar.Semantic`
OPTIONS (
  location = 'US',
  description = "L2 — business-meaning entities. Reusable across all L3 marts. See docs/01_ARCHITECTURE.md."
);

-- PipelineRuns outcome and job-lineage columns.
--
-- One additive statement. Every column is nullable so historical runs remain valid and read NULL
-- for values they did not record. ADD COLUMN IF NOT EXISTS preserves rows and makes reapplication
-- a no-op. Existing host and pipeline_version columns are reused.
--
-- Apply through the explicit migration helper after sandbox validation and separate production
-- approval. The pipeline checks these columns at startup and refuses an older table shape.
-- Identifiers are literal placeholders rendered by the migration helper.
ALTER TABLE `${PROJECT}.${DATASET}.PipelineRuns`
  ADD COLUMN IF NOT EXISTS execution_status STRING
    OPTIONS(description="completed, partial, refused, unsupported, empty or failed. A refusal is not a completed run."),
  ADD COLUMN IF NOT EXISTS units_planned INT64
    OPTIONS(description="Work units declared before guards run."),
  ADD COLUMN IF NOT EXISTS units_attempted INT64
    OPTIONS(description="Work units the pipeline attempted to read."),
  ADD COLUMN IF NOT EXISTS units_completed INT64
    OPTIONS(description="Work units whose complete range was captured."),
  ADD COLUMN IF NOT EXISTS units_noop INT64
    OPTIONS(description="Work units whose requested range was empty by arithmetic."),
  ADD COLUMN IF NOT EXISTS units_refused INT64
    OPTIONS(description="Work units refused before any chain read."),
  ADD COLUMN IF NOT EXISTS units_unsupported INT64
    OPTIONS(description="Work units the configured readers or release scope do not support."),
  ADD COLUMN IF NOT EXISTS units_failed INT64
    OPTIONS(description="Work units that ran but did not complete."),
  ADD COLUMN IF NOT EXISTS outcome_counts_by_grain JSON
    OPTIONS(description="Outcome counters for RawLogs and Transactions separately."),
  ADD COLUMN IF NOT EXISTS release_sha STRING
    OPTIONS(description="40-character lowercase Git SHA of the release that produced this run."),
  ADD COLUMN IF NOT EXISTS plan_hash STRING
    OPTIONS(description="64-character lowercase SHA-256 of the immutable execution plan."),
  ADD COLUMN IF NOT EXISTS parent_run_id STRING
    OPTIONS(description="Parent run identifier, NULL for a top-level run."),
  ADD COLUMN IF NOT EXISTS child_plan_stage STRING
    OPTIONS(description="Execution stage assigned to this child run."),
  ADD COLUMN IF NOT EXISTS child_plan_root_hash STRING
    OPTIONS(description="Hash of the complete child plan tree."),
  ADD COLUMN IF NOT EXISTS child_plan_hash STRING
    OPTIONS(description="Hash of this child run's plan."),
  ADD COLUMN IF NOT EXISTS child_ordinal INT64
    OPTIONS(description="Position in the complete child plan."),
  ADD COLUMN IF NOT EXISTS stage_child_ordinal INT64
    OPTIONS(description="Position within this stage's child plan."),
  ADD COLUMN IF NOT EXISTS stage_child_count INT64
    OPTIONS(description="Number of children declared for this stage."),
  ADD COLUMN IF NOT EXISTS bigquery_job_ledger JSON
    OPTIONS(description="Submitted work jobs and their terminal states."),
  ADD COLUMN IF NOT EXISTS job_ledger_hash STRING
    OPTIONS(description="Hash of the complete job ledger."),
  ADD COLUMN IF NOT EXISTS work_jobs_terminal BOOL
    OPTIONS(description="True only when every recorded work job is terminal."),
  ADD COLUMN IF NOT EXISTS terminalizer_job_id STRING
    OPTIONS(description="Identifier of the job that finalized this run record."),
  ADD COLUMN IF NOT EXISTS closure_status STRING
    OPTIONS(description="terminalized, closed or closure_invalidated."),
  ADD COLUMN IF NOT EXISTS terminalized_at TIMESTAMP
    OPTIONS(description="Timestamp assigned when terminalization was requested."),
  ADD COLUMN IF NOT EXISTS terminalized_row_hash STRING
    OPTIONS(description="Hash of the canonical terminal row, excluding this field."),
  ADD COLUMN IF NOT EXISTS closure_receipt_uri STRING
    OPTIONS(description="URI of the record that proves closure.");

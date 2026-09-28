-- 08_PipelineRunsOutcome_v1.sql
--
-- DO NOT RUN. This file is a migration DEFINITION, not a deployment step.
--
-- That banner is load bearing and it is the FIRST thing in this file on purpose.
-- `scripts/deploy-warehouse.ps1` executes every .sql file in this folder in filename order unless
-- its first twenty lines carry `DO NOT RUN` or `NOT THE LIVE SHAPE`. That bootstrap script is the
-- readiness audit's finding C3, it is owned by Phase 8, and it is not fixed yet. Adding a file
-- here without this banner would hand a live migration to a script that is already known to run
-- things nobody asked it to run. The banner is the only control that exists today, so this file
-- carries it, and it is not a substitute for fixing C3.
--
-- ONE STATEMENT. ADDITIVE ONLY. NOT APPLIED BY THIS PHASE.
--
-- WHAT THIS IS. The remediation plan's Phase 3 task 11 migration: the columns that let a
-- PipelineRuns row say what a run actually did, rather than carrying two counters that were
-- incremented separately from the outcomes they claim to describe.
--
-- WHY IT EXISTS. The readiness audit's finding C2 has two runtime receipts and both end the same
-- way. A bare `daily` planned 142 targets against a limit of 12, logged REFUSED, read nothing,
-- and persisted ZERO planned and ZERO failed captures. An XDC backfill requested 12,394,045
-- blocks against a limit of 1,296,000, wrote one refusal row, and persisted ONE planned and ONE
-- successful capture. In both cases the run record agreed with the exit code and both were wrong,
-- because the only shapes available were "succeeded" and "failed" and a refusal is neither. These
-- columns are the vocabulary that was missing.
--
-- SAFETY PROPERTIES, each one deliberate.
--
--   * Every clause is ADD COLUMN IF NOT EXISTS. There is no DROP, no ALTER COLUMN, no rename and
--     no data movement anywhere in this file. Running it twice is a no-op. This matters here
--     specifically: `04_L0Contract_v3.sql` carries three unconditional DROP TABLE statements and
--     one of them was executed against production by accident in this project's own history.
--   * One statement in one file, per plan section 1.2. Nothing extracts a fragment of this file
--     by delimiter or string slicing: the incident above was caused by exactly that, on a CRLF
--     file where the delimiter search returned -1 and took the rest of the file with it.
--   * `host` and `pipeline_version` are REUSED for runner identity and release version. Plan task
--     11 says so explicitly and forbids adding aliases for them, so neither appears below.
--   * Adding a column to a BigQuery table rewrites no rows and scans no bytes. Existing rows read
--     NULL for every column below, which is correct: those runs genuinely did not record this.
--
-- WHO APPLIES IT. Not this change. The migration is rehearsed against a sandbox dataset and
-- applied to production only inside an authorised additive-DDL window. What lands here is the
-- definition plus the code that reads and writes it, and `ensureInfraTables` asserts every
-- column at startup so a dataset that has not had this applied fails immediately, naming this
-- file, instead of failing at the INSERT after a whole run has already happened.
--
-- TARGET. Substitute the dataset deliberately. This file names no project so it cannot be run
-- against production by copy-paste alone.

ALTER TABLE `${PROJECT}.${DATASET}.PipelineRuns`
  -- The outcome model. `execution_status` is the word form of the exit code, because exit 2 does
  -- not distinguish a refusal from a crash and those need different responses.
  ADD COLUMN IF NOT EXISTS execution_status STRING
    OPTIONS(description="completed, partial, refused, unsupported, empty or failed. Never plain success: a refused run and a clean run must not share a word."),
  ADD COLUMN IF NOT EXISTS units_planned INT64
    OPTIONS(description="Work units this run intended, recorded BEFORE any guard ran. A globally refused run has a real planned count here; that number does not exist after the refusal."),
  ADD COLUMN IF NOT EXISTS units_attempted INT64
    OPTIONS(description="Units the pipeline actually tried to read. planned minus attempted is exactly the work this run declined."),
  ADD COLUMN IF NOT EXISTS units_completed INT64
    OPTIONS(description="Units that finished their whole range. The only value that is success."),
  ADD COLUMN IF NOT EXISTS units_noop INT64
    OPTIONS(description="Units whose range was empty by arithmetic. Not work, and not a completion: a run of pure no-ops exits nonzero."),
  ADD COLUMN IF NOT EXISTS units_refused INT64
    OPTIONS(description="Units a budget guard declined before reading. The range is unread and recorded as unread in IngestionCoverage with status refused_budget."),
  ADD COLUMN IF NOT EXISTS units_unsupported INT64
    OPTIONS(description="Units this pipeline cannot do: no reader for the chain, chain outside the frozen release scope, or an address the control plane does not know."),
  ADD COLUMN IF NOT EXISTS units_failed INT64
    OPTIONS(description="Units that ran and did not finish, whether they threw or returned an incomplete range."),
  ADD COLUMN IF NOT EXISTS outcome_counts_by_grain JSON
    OPTIONS(description="The same counters per target grain, RawLogs and Transactions separately, plus RawLogs+Transactions for run-level parent units. Reconciles exactly to the units_ columns."),
  ADD COLUMN IF NOT EXISTS release_sha STRING
    OPTIONS(description="40-character lowercase Git SHA of the release that produced this run. NULL until a release process sets it; a hash invented by the program it is supposed to bind would bind nothing."),
  ADD COLUMN IF NOT EXISTS plan_hash STRING
    OPTIONS(description="64-character lowercase hex SHA-256 of the remediation plan this writer is bound to, per plan section 1.1."),

  -- The child-plan lineage. A run may be a child of another run's plan, and the readiness audit's
  -- reconciliation requirement is that a parent's outcome be derivable from its children rather
  -- than asserted alongside them.
  ADD COLUMN IF NOT EXISTS parent_run_id STRING
    OPTIONS(description="The run that planned this one. NULL for an ordinary top-level run."),
  ADD COLUMN IF NOT EXISTS child_plan_stage STRING
    OPTIONS(description="Fixed lowercase stage enum this child belongs to."),
  ADD COLUMN IF NOT EXISTS child_plan_root_hash STRING
    OPTIONS(description="Hash of the whole plan tree this child was derived from."),
  ADD COLUMN IF NOT EXISTS child_plan_hash STRING
    OPTIONS(description="Hash of this child's own plan. Part of the canonical input to a deterministic child run id."),
  ADD COLUMN IF NOT EXISTS child_ordinal INT64
    OPTIONS(description="Position of this child in the global plan ordering."),
  ADD COLUMN IF NOT EXISTS stage_child_ordinal INT64
    OPTIONS(description="Position of this child within its own stage."),
  ADD COLUMN IF NOT EXISTS stage_child_count INT64
    OPTIONS(description="How many children the stage declared, so a missing child is detectable without a scan."),

  -- The job ledger and the closure chain. Written by the mutation broker and the terminalizer in
  -- later phases; defined here because plan task 11 fixes the column set and forbids Phase 8 from
  -- redefining it.
  ADD COLUMN IF NOT EXISTS bigquery_job_ledger JSON
    OPTIONS(description="Every WORK job this run submitted, with its submit intent and terminal state. The terminalizer is never in its own ledger."),
  ADD COLUMN IF NOT EXISTS job_ledger_hash STRING
    OPTIONS(description="Hash over the complete ledger, computed before terminalization."),
  ADD COLUMN IF NOT EXISTS work_jobs_terminal BOOL
    OPTIONS(description="True only when every parent and generated child work job reached a terminal state. Parent status alone is insufficient."),
  ADD COLUMN IF NOT EXISTS terminalizer_job_id STRING
    OPTIONS(description="The single committed terminalizer attempt. Once a terminalized row exists, no second terminalizer patches it."),
  ADD COLUMN IF NOT EXISTS closure_status STRING
    OPTIONS(description="terminalized, closed or closure_invalidated. terminalized is provisional and never means closed."),
  ADD COLUMN IF NOT EXISTS terminalized_at TIMESTAMP
    OPTIONS(description="Predetermined at intent creation and passed in as a typed parameter. The terminalizer may not call CURRENT_TIMESTAMP()."),
  ADD COLUMN IF NOT EXISTS terminalized_row_hash STRING
    OPTIONS(description="Hash over the canonical final fields excluding this field itself, so a recovered row can be proven byte-identical to the intended one."),
  ADD COLUMN IF NOT EXISTS closure_receipt_uri STRING
    OPTIONS(description="Predetermined URI of the closure object. That object alone makes a run closed.");

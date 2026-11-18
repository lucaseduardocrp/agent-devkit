-- A run's tests run again independently of each other: the queue keeps at most one active job per
-- scope of a run instead of one per run. The scope is the single test an `execute` job runs, or ''
-- (the whole run) for every other job. A job that takes the whole run never overlaps another one;
-- that cross-scope rule is part of the INSERT in the queue adapter.
DROP INDEX "e2e_jobs_one_active_per_creation";

CREATE UNIQUE INDEX "e2e_jobs_one_active_per_scope"
    ON "e2e_jobs" (
        "creation_id",
        (CASE WHEN "kind" = 'execute' AND jsonb_array_length("test_ids") = 1 THEN "test_ids"->>0 ELSE '' END)
    ) WHERE "status" IN ('queued', 'running');

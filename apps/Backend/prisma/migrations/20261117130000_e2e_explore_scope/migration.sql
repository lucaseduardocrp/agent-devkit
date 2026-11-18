-- An exploration of the application no longer takes the whole run: it only keeps another
-- exploration (and the jobs that do take the whole run) from starting, so a test can be rewritten
-- and executed while the run is being explored. The scope of an `explore` job is 'explore'; the
-- cross-scope rule (a job that takes the whole run never overlaps another one) stays in the INSERT
-- of the queue adapter.
DROP INDEX "e2e_jobs_one_active_per_scope";

CREATE UNIQUE INDEX "e2e_jobs_one_active_per_scope"
    ON "e2e_jobs" (
        "creation_id",
        (CASE
            WHEN "kind" = 'execute' AND jsonb_array_length("test_ids") = 1 THEN "test_ids"->>0
            WHEN "kind" = 'explore' THEN 'explore'
            ELSE ''
        END)
    ) WHERE "status" IN ('queued', 'running');

-- Stable test case IDs (metadata.caseId) let the audit history follow a single case.
UPDATE "saved_test_plans" p
SET "plans" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(t.elem) <> 'object' THEN t.elem
      WHEN jsonb_typeof(t.elem->'metadata') = 'object' AND (t.elem->'metadata') ? 'caseId' THEN t.elem
      ELSE jsonb_set(
        t.elem,
        '{metadata}',
        COALESCE(
          CASE WHEN jsonb_typeof(t.elem->'metadata') = 'object' THEN t.elem->'metadata' END,
          '{}'::jsonb
        ) || jsonb_build_object('caseId', gen_random_uuid()::text)
      )
    END
    ORDER BY t.ord
  )
  FROM jsonb_array_elements(p."plans") WITH ORDINALITY AS t(elem, ord)
)
WHERE jsonb_typeof(p."plans") = 'array' AND jsonb_array_length(p."plans") > 0;

-- Run with psql in autocommit mode; CONCURRENTLY cannot run inside a transaction.
-- This tiny partial covering index avoids scanning raw candidate rows that
-- cannot contribute to defect options.
create index concurrently if not exists daf_log_candidates_fail_line_idx
    on public.daf_log_candidates (line, id) include (defect)
    where status = 'FAIL';

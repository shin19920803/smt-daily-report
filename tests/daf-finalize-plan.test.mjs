import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin']
    .find(path => existsSync(join(path, 'initdb')));
if (!bin) throw new Error('需要本機 PostgreSQL 17；不會改用正式資料庫測試');
const root = mkdtempSync('/tmp/daf-finalize-plan-');
const data = join(root, 'data');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const run = (name, args) => execFileSync(join(bin, name), args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024
});
let started = false;
try {
    run('initdb', ['-D', data, '--auth=trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-o', `-k ${root} -p 55489 -c listen_addresses=''`, '-l', join(root, 'server.log'), 'start']);
    started = true;
    run('createdb', ['-h', root, '-p', '55489', '-U', userInfo().username, 'daf_plan_test']);
    run('psql', ['-h', root, '-p', '55489', '-U', userInfo().username, '-d', 'daf_plan_test', '--command', `
        create schema cron;
        create table cron.job(jobid bigint, jobname text, schedule text, command text);
        create function cron.unschedule(bigint) returns boolean language sql as $$ select true $$;
        create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
    `]);
    const args = ['-h', root, '-p', '55489', '-U', userInfo().username,
        '-d', 'daf_plan_test', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '-At'];
    // Reuse the five-process publication/backfill fixtures, not the later
    // calendar-dependent retention tests (which are unrelated to plan changes).
    const fixture = readFileSync(new URL('./daf-historical-compaction.test.sql', import.meta.url), 'utf8')
        .split('-- Simulate a staged job that began')[0];
    execFileSync(join(bin, 'psql'), [...args, '--file', '-'], { env, encoding: 'utf8', input: fixture,
        cwd: fileURLToPath(new URL('.', import.meta.url)), maxBuffer: 8 * 1024 * 1024, stdio: ['pipe','pipe','pipe'] });
    const refresh = `select public.refresh_daf_log_batch_summaries((select jsonb_agg(jsonb_build_object('line',line,'file_name',file_name)) from public.daf_log_active_file_processes));`;
    const digest = `select md5(string_agg(to_jsonb(b)::text,'|' order by id)) from public.daf_log_batches b;`;
    run('psql', [...args, '--command', refresh]);
    const before = run('psql', [...args, '--command', digest]);
    const migration = fileURLToPath(new URL('../supabase/daf_finalize_plan_fix.sql', import.meta.url));
    run('psql', [...args, '--file', migration]);
    run('psql', [...args, '--file', migration]);
    const keyMigration = fileURLToPath(new URL('../supabase/daf_finalize_key_lookup_fix.sql', import.meta.url));
    run('psql', [...args, '--file', keyMigration]);
    run('psql', [...args, '--file', keyMigration]);
    const fileMigration = fileURLToPath(new URL('../supabase/daf_finalize_file_scope_fix.sql', import.meta.url));
    run('psql', [...args, '--file', fileMigration]);
    run('psql', [...args, '--file', fileMigration]);
    run('psql', [...args, '--command', refresh]);
    assert.equal(run('psql', [...args, '--command', digest]), before, 'All summary fields must remain identical');
    run('psql', [...args, '--command', `do $$ declare i integer; payload jsonb; begin
      perform public.daf_start_log_import('99999999-0000-4000-8000-000000000001','plan-load.xlsx',
        '[{"line":"DAF","date_start":"2026-10-28","date_end":"2026-10-28"}]'::jsonb,44);
      for i in 0..43 loop
        select jsonb_agg(jsonb_build_object('dedupKey','LOAD-'||(i*500+n),'dedupTime',i*500+n,
          'date','2026-10-28','model','LOAD','workOrder','WO-LOAD','status','GOOD','inputIncluded',true))
          into payload from generate_series(1,500) n;
        perform public.daf_stage_log_import_chunk('99999999-0000-4000-8000-000000000001','DAF',i,'load-'||i,payload);
      end loop; end $$;`]);
    const startedAt = Date.now();
    const published = JSON.parse(run('psql', [...args, '--command',
        `select public.daf_finalize_log_import('99999999-0000-4000-8000-000000000001');`]));
    assert.equal(published.accepted_count, 22000);
    assert.equal(published.published, true);
    console.log(`44-chunk / 22,000-row local publication: ${Date.now()-startedAt} ms`);
    const originalDelete = run('psql', [...args, '--command',
        `begin; select public.daf_delete_log_file('plan-load.xlsx'); ${digest} rollback;`]).trim().split('\n').filter(Boolean);
    const deleteMigration = fileURLToPath(new URL('../supabase/daf_delete_file_performance_fix.sql', import.meta.url));
    const beforeDeleteMigration = run('psql', [...args, '--command', digest]);
    run('psql', [...args, '--file', deleteMigration]);
    run('psql', [...args, '--file', deleteMigration]);
    assert.equal(run('psql', [...args, '--command', digest]), beforeDeleteMigration, 'Delete migration must not change data');
    const optimizedDelete = run('psql', [...args, '--command',
        `begin; select public.daf_delete_log_file('plan-load.xlsx'); ${digest} rollback;`]).trim().split('\n').filter(Boolean);
    assert.deepEqual(optimizedDelete, originalDelete, 'Deletion must preserve complete summary results');
    run('psql', [...args, '--command', `select public.daf_delete_log_file('plan-load.xlsx');`]);
    assert.equal(run('psql', [...args, '--command', `select count(*) from public.daf_log_active_file_processes where file_name='plan-load.xlsx';`]).trim(), '0');
    run('psql', [...args, '--command', `select public.daf_delete_log_file('plan-load.xlsx');`]);
    assert.equal(run('psql', [...args, '--command', digest]).trim(), before.trim(), 'Repeated deletion must return to pre-upload data');
    for (const [suffix, time] of [['1', 10], ['2', 20]]) {
        run('psql', [...args, '--command', `
            select public.daf_start_log_import('88888888-0000-4000-8000-00000000000${suffix}', 'delete-${suffix}.xlsx',
                '[{"line":"DAF","date_start":"2026-10-28","date_end":"2026-10-28"}]'::jsonb,1);
            select public.daf_stage_log_import_chunk('88888888-0000-4000-8000-00000000000${suffix}','DAF',0,'test',
                '[{"dedupKey":"DELETE-SHARED","dedupTime":${time},"date":"2026-10-28","status":"GOOD","inputIncluded":true},
                  {"date":"2026-10-28","status":"FAIL","defect":"test","inputIncluded":true}]'::jsonb);
            select public.daf_finalize_log_import('88888888-0000-4000-8000-00000000000${suffix}');`]);
    }
    run('psql', [...args, '--command', `select public.daf_delete_log_file('delete-1.xlsx');`]);
    assert.equal(run('psql', [...args, '--command', `select file_name from public.daf_log_winners where line='DAF' and dedup_key='DELETE-SHARED';`]).trim(), 'delete-2.xlsx', 'Next earliest candidate must win after deleting the first file');
    assert.equal(run('psql', [...args, '--command', `select count(*) from public.daf_log_winners where file_name='delete-1.xlsx';`]).trim(), '0', 'Blank E rows of deleted file must also disappear');
    const beforeArchiveDelete = run('psql', [...args, '--command', digest]);
    run('psql', [...args, '--command', `insert into public.daf_log_compacted_files(line,file_name) values ('DAF','delete-2.xlsx');`]);
    assert.throws(() => run('psql', [...args, '--command', `select public.daf_delete_log_file('delete-2.xlsx');`]));
    assert.equal(run('psql', [...args, '--command', digest]), beforeArchiveDelete, 'Archive rejection must roll back completely');
    assert.equal(run('psql', [...args, '--command', `select public.daf_log_file_exists('delete-2.xlsx');`]).trim(), 't');
    assert.equal(run('psql', [...args, '--command', `select public.daf_log_file_exists('delete-1.xlsx');`]).trim(), 'f');
    assert.throws(() => run('psql', [...args, '--command', `begin; update dashboard_private.access_settings set enabled=true;
        set local request.jwt.claims='{"role":"anon"}'; select public.daf_log_file_exists('delete-2.xlsx'); rollback;`]));
    console.log('PASS: five-process publication fixtures and identical complete summary digest after idempotent plan migration');
} finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
    rmSync(root, { recursive: true, force: true });
}

// Self-contained PostgreSQL test. Only a newly-created local socket/database is used.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = ['/opt/homebrew/opt/postgresql@17/bin','/usr/local/opt/postgresql@17/bin']
    .find(path => existsSync(join(path,'initdb')));
if (!bin) throw new Error('需要本機 PostgreSQL 17 測試工具；不會改用線上資料庫');
const root = mkdtempSync('/tmp/daf-maintenance-budget-');
const data = join(root,'data');
const migration = fileURLToPath(new URL('../supabase/daf_maintenance_statement_budget_fix.sql',import.meta.url));
const args = ['-h',root,'-p','55485','-U',userInfo().username,'-d','daf_maintenance_budget_test',
    '--no-psqlrc','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','-At'];
const env = {...process.env};
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const run = (name,args) => execFileSync(join(bin,name),args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql = command => run('psql',[...args,'--command',command]).trim();
let started = false;
try {
    run('initdb',['-D',data,'--auth=trust','--no-locale','-E','UTF8']);
    run('pg_ctl',['-D',data,'-o',`-k ${root} -p 55485 -c listen_addresses=''`,'-l',join(root,'server.log'),'start']);
    started = true;
    run('createdb',['-h',root,'-p','55485','-U',userInfo().username,'daf_maintenance_budget_test']);
    assert.equal(sql('select current_database()'),'daf_maintenance_budget_test');
    sql(`create schema cron;
      create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
      create function cron.alter_job(job_id bigint,command text) returns void language sql as
      'update cron.job j set command=$2 where jobid=$1';
      insert into cron.job values
        (9,'production-daf-log-maintenance','*/3 * * * *','select public.daf_run_log_maintenance_batch();',true),
        (7,'production-daf-failed-import-cleanup','*/5 * * * *','select public.daf_prune_failed_log_imports();',true),
        (99,'unrelated','0 0 * * *','select 1;',false);
      create table production_sentinel(id integer primary key,quantity integer);
      insert into production_sentinel values(1,123);
      create table maintenance_probe_writes(id integer);
      create function public.daf_run_log_maintenance_batch() returns jsonb language plpgsql
      set statement_timeout='5ms' as $$ begin
        begin
          insert into maintenance_probe_writes values(1);
          perform pg_sleep(0.15);
          return '{"done":true}'::jsonb;
        exception when query_canceled then return '{"deferred_reason":"maintenance_time_budget"}'::jsonb;
        end;
      end $$;
      create function public.daf_prune_failed_log_imports() returns integer language plpgsql
      set statement_timeout='55s' as $$ begin
        insert into maintenance_probe_writes values(2); perform pg_sleep(0.15); return 1;
      end $$;`);
    sql('set statement_timeout=0; select public.daf_run_log_maintenance_batch();');
    assert.equal(sql('select count(*) from maintenance_probe_writes'),'1',
        'Reproduction: function-level 5ms must not limit the already-started 150ms SELECT');
    sql('delete from maintenance_probe_writes;');
    const unchanged = () => sql("select jsonb_agg(jsonb_build_array(jobid,schedule,active) order by jobid) from cron.job;") +
        sql('select row_to_json(s) from production_sentinel s;');
    const before = unchanged();
    run('psql',[...args,'--file',migration]);
    const commands = sql('select command from cron.job where jobid in (7,9) order by jobid;').split('\n');
    assert(commands.every(command => command.startsWith("set statement_timeout = '7s'; set lock_timeout = '1s'; select")));
    const jobCommands = sql('select jobid,command from cron.job order by jobid;');
    run('psql',[...args,'--file',migration]);
    assert.equal(sql('select jobid,command from cron.job order by jobid;'),jobCommands,'Migration is idempotent');
    assert.equal(unchanged(),before,'Schedules, active flags, unrelated jobs and production data must not change');
    const boundedMain = commands[1].replace("'7s'","'40ms'");
    assert.match(sql(boundedMain),/maintenance_time_budget/);
    assert.equal(sql('select count(*) from maintenance_probe_writes'),'0','Cancelled inner batch must roll back');
    const boundedCleanup = commands[0].replace("'7s'","'40ms'");
    const failed = spawnSync(join(bin,'psql'),[...args,'--command',boundedCleanup],{env,encoding:'utf8'});
    assert.notEqual(failed.status,0);
    assert.match(failed.stderr,/57014/);
    assert.equal(sql('select count(*) from maintenance_probe_writes'),'0','Cancelled cleanup must roll back');
    const unsupportedMode = spawnSync(join(bin,'psql'),[...args,
        '--command',"set cron.use_background_workers='on';",'--file',migration],{env,encoding:'utf8'});
    assert.notEqual(unsupportedMode.status,0,'Must reject an executor where the SET prefix cannot arm its timer');
    assert.equal(sql('select jobid,command from cron.job order by jobid;'),jobCommands);
    sql("update cron.job set command='select unexpected();' where jobid=9;");
    const conflicting = sql('select jobid,command from cron.job order by jobid;');
    const rejected = spawnSync(join(bin,'psql'),[...args,'--file',migration],{env,encoding:'utf8'});
    assert.notEqual(rejected.status,0);
    assert.equal(sql('select jobid,command from cron.job order by jobid;'),conflicting,'Unexpected jobs abort the entire migration');
    sql('create role anon; create role authenticated;');
    run('createdb',['-h',root,'-p','55485','-U',userInfo().username,'daf_cleanup_regression_test']);
    run('psql',[...args.map(value => value==='daf_maintenance_budget_test' ? 'daf_cleanup_regression_test' : value),
        '--file',fileURLToPath(new URL('../tests/daf-failed-import-cleanup.test.sql',import.meta.url))]);
    console.log('PASS: reproduced ineffective function timeout; outer cron deadline cancels work, rolls back partial writes, preserves schedules/data and is idempotent; full failed-import cleanup SQL regression passed.');
} finally {
    if (started) run('pg_ctl',['-D',data,'-m','fast','stop']);
    rmSync(root,{recursive:true,force:true});
}

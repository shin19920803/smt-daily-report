import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin']
    .find(path => existsSync(join(path, 'initdb')));
if (!bin) throw new Error('需要本機 PostgreSQL 17 測試工具；不會連線或修改線上資料庫');

const root = mkdtempSync('/tmp/auto-tester-sql-');
const data = join(root, 'data');
const migration = fileURLToPath(new URL('../supabase/auto_tester_daily_capacity.sql', import.meta.url));
const user = userInfo().username;
const portServer = createServer();
const port = await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', () => {
        const value = portServer.address().port;
        portServer.close(error => error ? reject(error) : resolve(value));
    });
});
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const run = (name, args) => execFileSync(join(bin, name), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const psqlArgs = database => ['-h', root, '-p', String(port), '-U', user, '-d', database, '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '-qAt'];
const sql = (database, command) => run('psql', [...psqlArgs(database), '--command', command]).trim();
const rpc = (expression, account = '10000000-0000-0000-0000-000000000001') =>
    sql('auto_tester_test', `begin; set local test.account_id='${account}'; select ${expression}; commit;`);
const entries = rows => `$payload$${JSON.stringify(rows)}$payload$::jsonb`;
const publish = (name, sha, rows, replaceId = 'null') => rpc(
    `public.auto_tester_publish_file('${name}', '${sha}', ${entries(rows)}, ${replaceId})`);
let started = false;

try {
    run('initdb', ['-D', data, '--auth=trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-o', `-k ${root} -p ${port} -c listen_addresses=''`, '-l', join(root, 'server.log'), 'start']);
    started = true;
    run('createdb', ['-h', root, '-p', String(port), '-U', user, 'auto_tester_test']);
    sql('auto_tester_test', `create role anon; create role authenticated;
        create schema dashboard_private;
        create function dashboard_private.current_account_id() returns uuid language sql stable as $$
          select nullif(current_setting('test.account_id', true), '')::uuid $$;`);
    run('psql', [...psqlArgs('auto_tester_test'), '--file', migration]);

    const unauthenticated = spawnSync(join(bin, 'psql'), [...psqlArgs('auto_tester_test'), '--command', 'select public.auto_tester_get_state();'], { env, encoding: 'utf8' });
    assert.notEqual(unauthenticated.status, 0, 'RPC must fail closed without a dashboard session');
    assert.match(unauthenticated.stderr, /PT401/);
    const directTableRead = spawnSync(join(bin, 'psql'), [...psqlArgs('auto_tester_test'), '--command', 'set role anon; select * from public.auto_tester_daily_summary;'], { env, encoding: 'utf8' });
    assert.notEqual(directTableRead.status, 0, 'Anonymous browser role must not read base tables directly');

    const qrA = 'a'.repeat(64), qrB = 'b'.repeat(64), qrC = 'c'.repeat(64), qrD = 'd'.repeat(64);
    const day1 = '2026-10-21', day2 = '2026-10-22';
    const fileA = JSON.parse(publish('a.csv', '1'.repeat(64), [
        { report_date: day1, qr_hash: qrA }, { report_date: day1, qr_hash: qrB }
    ]));
    assert.equal(fileA.status, 'published');
    assert.equal(JSON.parse(rpc(`public.auto_tester_get_summary('${day1}', '${day1}')`)).daily[0].daily_count, 2);

    assert.equal(JSON.parse(publish('a.csv', '1'.repeat(64), [
        { report_date: day1, qr_hash: qrA }, { report_date: day1, qr_hash: qrB }
    ])).status, 'duplicate', 'Exact same file upload must be idempotent');
    assert.equal(JSON.parse(publish('a.csv', '2'.repeat(64), [
        { report_date: day2, qr_hash: qrC }
    ])).status, 'confirmation_required', 'Changed content under the same name requires explicit replacement confirmation');

    const badReplacement = spawnSync(join(bin, 'psql'), [...psqlArgs('auto_tester_test'), '--command',
        `begin; set local test.account_id='10000000-0000-0000-0000-000000000001'; select public.auto_tester_publish_file('a.csv','${'2'.repeat(64)}',${entries([{ report_date: day2, qr_hash: 'bad' }])},'${fileA.file_id}'); commit;`], { env, encoding: 'utf8' });
    assert.notEqual(badReplacement.status, 0, 'Invalid replacement payload must fail before changing stored rows');
    assert.equal(JSON.parse(rpc(`public.auto_tester_get_summary('${day1}', '${day1}')`)).daily[0].daily_count, 2);

    const replaced = JSON.parse(publish('a.csv', '2'.repeat(64), [
        { report_date: day2, qr_hash: qrB }, { report_date: day2, qr_hash: qrC }
    ], `'${fileA.file_id}'`));
    assert.equal(replaced.status, 'published');
    assert.deepEqual(JSON.parse(rpc(`public.auto_tester_get_summary('${day1}', '${day1}')`)).daily, [], 'Replacing a file removes its old date only when no other file contributes');

    const fileB = JSON.parse(publish('b.csv', '3'.repeat(64), [
        { report_date: day2, qr_hash: qrC }, { report_date: day2, qr_hash: qrD }
    ]));
    assert.equal(fileB.status, 'published');
    assert.equal(JSON.parse(rpc(`public.auto_tester_get_summary('${day2}', '${day2}')`)).daily[0].daily_count, 3,
        'Same QR in different files is counted once for the day');
    const listing = JSON.parse(rpc('public.auto_tester_list_files(25, 0)'));
    assert.equal(listing.total_count, 2);
    assert.equal(JSON.stringify(listing).includes('qr_hash'), false, 'File list must not expose QR hashes');

    const removedA = JSON.parse(rpc(`public.auto_tester_delete_file('${replaced.file_id}')`));
    assert.equal(removedA.deleted, true);
    assert.equal(JSON.parse(rpc(`public.auto_tester_get_summary('${day2}', '${day2}')`)).daily[0].daily_count, 2,
        'Deleting one file keeps QR codes that remain in another file');
    const removedB = JSON.parse(rpc(`public.auto_tester_delete_file('${fileB.file_id}')`));
    assert.equal(removedB.deleted, true);
    assert.deepEqual(JSON.parse(rpc(`public.auto_tester_get_summary('${day2}', '${day2}')`)).daily, [], 'Deleting the last contributing file removes the daily summary');

    const columns = sql('auto_tester_test', `select string_agg(column_name, ',' order by ordinal_position)
        from information_schema.columns where table_schema='public' and table_name='auto_tester_file_qr';`);
    assert.equal(columns, 'file_id,report_date,qr_hash', 'Persistent comparison detail contains hashes only, not raw QR values or source rows');
    console.log('PASS: isolated SQL migration, session/RLS gates, cross-file distinct counts, idempotent uploads, confirmed atomic replacement and delete recomputation.');
} finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', 'stop']);
    rmSync(root, { recursive: true, force: true });
}
